/** Fresh engineering fixtures. Never import into production entrypoints. */
export function inventedFixture(label: string): string {
  return "INVENTED-NONLIVE-FIXTURE:" + label;
}

export function inventedAccountNumber(label: string): string {
  // Clearly generated numeric input exercises number redaction without using
  // a brokerage identifier. The label and arithmetic are part of its provenance.
  return String(100000000 + Array.from(label).reduce((sum, char) => sum + char.charCodeAt(0), 0));
}
