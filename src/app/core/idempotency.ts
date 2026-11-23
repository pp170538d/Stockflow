/**
 * Idempotency key for one kind of write.
 *
 * - Same payload after a failure  -> same key  (safe retry: the server
 *   returns the first result instead of writing twice).
 * - Different payload or after done() -> new key.
 */
export class IdempotencyKey {
  private key = newKey();
  private payload: string | null = null;

  for(payload: unknown): string {
    const p = JSON.stringify(payload);
    if (p !== this.payload) {
      this.key = newKey();
      this.payload = p;
    }
    return this.key;
  }

  /** Call after a successful write so the next one gets a fresh key. */
  done(): void {
    this.payload = null;
  }
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // RFC 4122 v4 fallback (older Safari / non-secure context)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
