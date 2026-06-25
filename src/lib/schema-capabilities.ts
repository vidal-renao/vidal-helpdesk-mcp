export function ticketMetadataEnabled(): boolean {
  return process.env.SUPABASE_TICKETS_HAS_METADATA === "true";
}
