import { describe, expect, it } from "vitest";
import { type Actor, authorStats, isBot } from "../src/collect/github.ts";

const user = (login: string, name: string | null = login): Actor => ({ login, name, type: "User" });
const commitBy = (name: string): Actor => ({ login: null, name, type: null });
const repeat = (actor: Actor, times: number) => Array.from({ length: times }, () => actor);

describe("isBot", () => {
  it.each([
    "dependabot[bot]",
    "renovate[bot]",
    "github-actions[bot]",
    "semantic-release-bot",
    "snyk-bot",
    "greenkeeper",
    "dependabot",
    "renovate",
    "some_release_bot",
    "Copilot",
  ])("%s is a bot by name", (login) => {
    expect(isBot(user(login))).toBe(true);
    expect(isBot(commitBy(login))).toBe(true);
  });

  it.each(["sindresorhus", "UziTech", "robot", "abbot", "lovell", "bottle-dev"])(
    "%s is a human",
    (login) => {
      expect(isBot(user(login))).toBe(false);
    },
  );

  it("trusts GitHub's Bot account type", () => {
    expect(isBot({ login: "my-release-app", name: null, type: "Bot" })).toBe(true);
  });

  it("checks the git author name when the login is a person", () => {
    expect(isBot({ login: "octo", name: "renovate[bot]", type: "User" })).toBe(true);
  });
});

describe("authorStats", () => {
  it("reads all-bot history as no human committers, not as zero commits", () => {
    // @octokit/core: every recent commit is Renovate or Dependabot; PR authors are Bot accounts.
    const commits = [...repeat(user("renovate[bot]"), 14), ...repeat(user("dependabot[bot]"), 11)];
    const prs = [
      ...repeat({ login: "renovate", name: null, type: "Bot" }, 29),
      ...repeat(user("wolfy1339"), 4),
    ];
    expect(authorStats(commits, prs)).toEqual({
      sampled_commits: 25,
      sampled_commits_by_bots: 25,
      human_committers: 0,
      top_human_committer: null,
      top_human_committer_share: null,
      merged_prs_by_others_share: null,
    });
  });

  it("keeps release bots out of the top committer and PR share", () => {
    // marked: semantic-release-bot commits every release but never opens PRs.
    const commits = [
      ...repeat(user("semantic-release-bot"), 10),
      ...repeat(user("dependabot[bot]"), 6),
      ...repeat(user("UziTech", "Tony Brix"), 6),
      ...repeat(user("spokodev"), 3),
      commitBy("Someone Unlinked"),
    ];
    const prs = [
      ...repeat({ login: "dependabot", name: null, type: "Bot" }, 8),
      ...repeat(user("uzitech"), 2),
      ...repeat(user("spokodev"), 3),
      user("someone"),
    ];
    expect(authorStats(commits, prs)).toEqual({
      sampled_commits: 26,
      sampled_commits_by_bots: 16,
      human_committers: 3,
      top_human_committer: "UziTech",
      top_human_committer_share: 0.6,
      merged_prs_by_others_share: 0.67,
    });
  });
});
