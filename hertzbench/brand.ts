// The product name lives here and in README.md only, so a rename stays a
// search-and-replace. The CLI is `hertzbench` with the short alias `hzb`; a
// binary called plain `hertz` would collide with CloudWeGo Hertz (PLAN.md §2).
export const PRODUCT = {
  displayName: "Hertzbench",
  slug: "hertzbench",
  cli: "hertzbench",
  cliAlias: "hzb",
} as const;
