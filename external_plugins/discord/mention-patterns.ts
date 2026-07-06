/**
 * FLY-898 — per-group name-mention patterns (pure, testable).
 *
 * The plugin's `isMentioned` checks a real `<@id>` / reply-to-self AND a list of
 * name regexes ("extra patterns"). Historically that list was GLOBAL
 * (`access.mentionPatterns`) for every group. FLY-898 lets a single group OVERRIDE
 * it so a project's core room can be made id-only for a non-CoS lead: setting the
 * core group's `mentionPatterns: []` drops the name-regex path (only a real @ /
 * reply-to-self counts) while OTHER groups (e.g. #leads-roundtable) keep the global
 * name patterns.
 *
 * The critical semantic — and the reason this is a named function with a test
 * rather than an inline `??`: an EMPTY per-group array must be RESPECTED (id-only),
 * NOT treated as "unset → fall back to global". `[] ?? global` is `[]` (nullish
 * coalescing only falls back on null/undefined), so the empty array is the id-only
 * signal; only an ABSENT field falls back to the global patterns (byte-compat).
 */

export interface GroupMentionPolicy {
  mentionPatterns?: string[]
}
export interface AccessMentionPatterns {
  mentionPatterns?: string[]
}

/** The effective name-mention patterns for a group: the group's own list when
 * present (incl. an empty list = id-only), else the global list (byte-compat). */
export function resolveGroupMentionPatterns(
  policy: GroupMentionPolicy | undefined,
  access: AccessMentionPatterns,
): string[] | undefined {
  return policy?.mentionPatterns ?? access.mentionPatterns
}
