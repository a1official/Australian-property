/**
 * Covers Gmail API message parsing, attachment handling, and MIME reply
 * construction, including the threaded multi-attachment reply.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  GmailApiClient,
  buildMimeReply,
  buildReplySubject,
  findCsvPart,
  headerValue,
  parseAddress,
  replyHtmlBody,
  replyPlainTextBody,
  type GmailPart,
} from "../lib/gmail-api";
import { NeedsReauthorizationError } from "../lib/gmail-oauth";

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

test("a From header is parsed into name and address", () => {
  assert.deepEqual(parseAddress('"Agent Smith" <agent@example.com>'), { name: "Agent Smith", email: "agent@example.com" });
  assert.deepEqual(parseAddress("plain@example.com"), { name: "", email: "plain@example.com" });
  assert.equal(parseAddress("MiXeD@Example.COM").email, "mixed@example.com");
});

test("headers are read case-insensitively", () => {
  const part: GmailPart = { headers: [{ name: "Subject", value: "Rent review" }] };
  assert.equal(headerValue(part, "subject"), "Rent review");
  assert.equal(headerValue(part, "missing"), "");
});

test("a nested CSV attachment is found", () => {
  const payload: GmailPart = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: "aGk=" } },
      {
        mimeType: "multipart/related",
        parts: [{ filename: "batch.csv", mimeType: "text/csv", body: { attachmentId: "att-1", size: 120 } }],
      },
    ],
  };
  assert.equal(findCsvPart(payload)?.filename, "batch.csv");
});

test("a non-CSV attachment is ignored", () => {
  const payload: GmailPart = {
    parts: [{ filename: "photo.png", mimeType: "image/png", body: { attachmentId: "a" } }],
  };
  assert.equal(findCsvPart(payload), null);
});

test("a CSV part without body content is not treated as an attachment", () => {
  assert.equal(findCsvPart({ filename: "empty.csv", mimeType: "text/csv" }), null);
});

test("listing returns candidate ids only", async () => {
  const client = new GmailApiClient("token", jsonFetch(200, { messages: [{ id: "m1", threadId: "t1" }] }));
  const messages = await client.listCandidateMessages("has:attachment filename:csv", 5);
  assert.deepEqual(messages, [{ id: "m1", threadId: "t1" }]);
});

test("an empty inbox yields an empty list, not an error", async () => {
  const client = new GmailApiClient("token", jsonFetch(200, {}));
  assert.deepEqual(await client.listCandidateMessages("q", 5), []);
});

test("a 401 from Gmail becomes needs_reauthorization", async () => {
  const client = new GmailApiClient("expired", jsonFetch(401, { error: { message: "Invalid Credentials" } }));
  await assert.rejects(() => client.listCandidateMessages("q", 5), NeedsReauthorizationError);
});

test("a Gmail error message is not forwarded to the caller", async () => {
  const client = new GmailApiClient("token", jsonFetch(403, { error: { message: "sensitive upstream detail" } }));
  await assert.rejects(
    () => client.listCandidateMessages("q", 5),
    (error: unknown) => error instanceof Error && !error.message.includes("sensitive upstream detail"),
  );
});

test("attachment bytes are base64url decoded", async () => {
  const csv = "address\n1 Test Street SYDNEY NSW 2000\n";
  const client = new GmailApiClient("token", jsonFetch(200, { data: Buffer.from(csv).toString("base64url") }));
  const bytes = await client.getAttachment("m1", "a1");
  assert.equal(bytes.toString("utf8"), csv);
});

test("an oversized attachment is rejected as permanent", async () => {
  const big = Buffer.alloc(1_100_000, 0x41).toString("base64url");
  const client = new GmailApiClient("token", jsonFetch(200, { data: big }));
  await assert.rejects(
    () => client.getAttachment("m1", "a1"),
    (error: unknown) => (error as { permanent?: boolean }).permanent === true,
  );
});

test("sending threads the reply when a threadId is supplied", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "sent-1", threadId: "t1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const client = new GmailApiClient("token", fetchImpl);
  const result = await client.sendMessage("cmF3", "t1");
  assert.equal(result.id, "sent-1");
  assert.equal((calls[0].body as { threadId: string }).threadId, "t1");
  assert.match(calls[0].url, /\/messages\/send$/);
});

test("the reply subject is prefixed once", () => {
  assert.equal(buildReplySubject("Rent review"), "Re: Rent review");
  assert.equal(buildReplySubject("Re: Re: Rent review"), "Re: Rent review");
  assert.equal(buildReplySubject(""), "Re: Parcel Atlas property reports");
});

test("the plain-text body is never empty and states the report count", () => {
  const body = replyPlainTextBody(3, 0);
  assert.ok(body.trim().length > 60);
  assert.match(body, /3 properties/);
  assert.ok(!body.includes("undefined"));
});

test("review rows are disclosed in both bodies", () => {
  assert.match(replyPlainTextBody(2, 1), /manual review/);
  assert.match(replyHtmlBody(2, 1, ["a.html"]), /manual review/);
  assert.ok(!replyPlainTextBody(2, 0).includes("manual review"));
});

test("the HTML body escapes attachment names", () => {
  const html = replyHtmlBody(1, 0, ["<script>evil</script>.html"]);
  assert.ok(!html.includes("<script>evil"));
  assert.match(html, /&lt;script&gt;/);
});

test("a MIME reply carries every attachment and both body parts", () => {
  const raw = buildMimeReply({
    to: "agent@example.com",
    subject: "Re: Rent review",
    inReplyTo: "<original@mail.gmail.com>",
    references: "<original@mail.gmail.com>",
    plainText: replyPlainTextBody(3, 0),
    html: replyHtmlBody(3, 0, ["parcel-atlas-1.html", "parcel-atlas-2.html", "parcel-atlas-3.html"]),
    attachments: [
      { filename: "parcel-atlas-1.html", mimeType: "text/html", content: "<html>1</html>" },
      { filename: "parcel-atlas-2.html", mimeType: "text/html", content: "<html>2</html>" },
      { filename: "parcel-atlas-3.html", mimeType: "text/html", content: "<html>3</html>" },
    ],
  });

  const decoded = decodeRaw(raw);
  assert.match(decoded, /^To: agent@example.com/m);
  assert.match(decoded, /^Subject: Re: Rent review/m);
  assert.match(decoded, /^In-Reply-To: <original@mail\.gmail\.com>/m, "threading header present");
  assert.match(decoded, /multipart\/mixed/);
  assert.match(decoded, /multipart\/alternative/);
  assert.match(decoded, /text\/plain/);
  assert.match(decoded, /text\/html/);

  for (const name of ["parcel-atlas-1.html", "parcel-atlas-2.html", "parcel-atlas-3.html"]) {
    assert.ok(decoded.includes(`filename="${name}"`), `${name} must be attached`);
  }
  assert.equal((decoded.match(/Content-Disposition: attachment/g) ?? []).length, 3);
});

test("the raw message is base64url encoded, not standard base64", () => {
  const raw = buildMimeReply({
    to: "a@b.com",
    subject: "Test",
    plainText: "hello",
    html: "<p>hello</p>",
    attachments: [{ filename: "r.html", mimeType: "text/html", content: "<html/>" }],
  });
  assert.ok(!raw.includes("+") && !raw.includes("/") && !raw.includes("="), "must be URL-safe with no padding");
});

test("a non-ASCII subject is RFC 2047 encoded", () => {
  const raw = buildMimeReply({
    to: "a@b.com",
    subject: "Rapport – propriété",
    plainText: "x",
    html: "<p>x</p>",
    attachments: [{ filename: "r.html", mimeType: "text/html", content: "<html/>" }],
  });
  assert.match(decodeRaw(raw), /Subject: =\?UTF-8\?B\?/);
});
