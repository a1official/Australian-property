# Local Gmail CSV-to-report setup

1. In Google Cloud Console, create a **Web application** OAuth client and enable the Gmail API.
2. Add `http://localhost:3004/api/gmail/callback` as an authorised redirect URI.
3. Add the variables in `frontend/.env.example` to `D:\Realstate\.env`; do not commit them.
4. Start the app with `npm run dev -- -p 3004` from `frontend`.
5. In the Batch reports section, select **Connect Gmail** and authorise the dedicated mailbox.
6. Send a CSV with an `address` column from an email listed in `GMAIL_ALLOWED_SENDERS`, then select **Check inbox**.
7. Review any ambiguous address matches, generate reports, then select **Send reports back**.

The local connection token is stored in `D:\Realstate\.local\gmail-connection.json`. It is intentionally ignored by Git. The current local workflow is manually triggered from the inbox panel; a production version should replace that button with Gmail Watch plus Pub/Sub and a durable job queue.
