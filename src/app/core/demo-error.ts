/**
 * Maps database-level demo restrictions to a single user-facing message.
 *
 * The demo account is blocked in two ways:
 *   - RLS policies   -> "violates row-level security policy"
 *   - trigger guards -> "DEMO_READONLY: ..."
 *
 * Both are intentional, not bugs, so they must never surface raw.
 * Any other message is passed through untouched.
 */
export function demoFriendly(msg: string): string {
  if (msg.includes('DEMO_READONLY') || msg.includes('row-level security')) {
    return 'This action is disabled in the demo account.';
  }
  return msg;
}