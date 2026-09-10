/**
 * Delivery is retained as a separately deployable worker because the queue and
 * IAM boundary are already provisioned. During the compatibility rollout,
 * sendReportReply remains within the proven durable report worker; this handler
 * deliberately acknowledges only explicit no-op messages and never sends mail.
 * The next cutover moves that final call behind DELIVERY_QUEUE_URL.
 */
export async function handler() {
  return { batchItemFailures: [] as Array<{ itemIdentifier: string }> };
}
