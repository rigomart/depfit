/** GitHub GraphQL facts about a package's repository. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Maintenance } from "../report.ts";
import { asArray, asNumber, asRecord, asString, DAY_MS, round } from "./util.ts";

const run = promisify(execFile);

export type GithubFacts = Pick<
  Maintenance,
  | "archived"
  | "stars"
  | "last_commit_at"
  | "commits_last_90d"
  | "commits_last_year"
  | "sampled_commits"
  | "sampled_commits_by_bots"
  | "human_committers"
  | "top_human_committer"
  | "top_human_committer_share"
  | "merged_prs_by_others_share"
  | "open_issues"
  | "open_prs"
  | "issues_median_days_to_close"
>;

export const NO_GITHUB: GithubFacts = {
  archived: null,
  stars: null,
  last_commit_at: null,
  commits_last_90d: null,
  commits_last_year: null,
  sampled_commits: null,
  sampled_commits_by_bots: null,
  human_committers: null,
  top_human_committer: null,
  top_human_committer_share: null,
  merged_prs_by_others_share: null,
  open_issues: null,
  open_prs: null,
  issues_median_days_to_close: null,
};

/** GITHUB_TOKEN, GH_TOKEN, then `gh auth token`; null when none is available. */
export async function githubToken(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// `latest` is queried separately: the first node of `recent` is not the newest commit when the
// history is filtered by `since`.
const QUERY = `
query($owner: String!, $repo: String!, $since365: GitTimestamp!, $since90: GitTimestamp!) {
  repository(owner: $owner, name: $repo) {
    stargazerCount
    isArchived
    defaultBranchRef {
      target {
        ... on Commit {
          recent: history(first: 100, since: $since365) {
            totalCount
            nodes { author { user { login __typename } name } }
          }
          last90: history(first: 1, since: $since90) { totalCount }
          latest: history(first: 1) { nodes { committedDate } }
        }
      }
    }
    openIssues: issues(states: OPEN) { totalCount }
    openPRs: pullRequests(states: OPEN) { totalCount }
    mergedPRs: pullRequests(states: MERGED, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { author { login __typename } }
    }
    recentIssues: issues(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { createdAt closedAt }
    }
  }
}`;

/** A commit or PR author as GitHub reports it. `type` is the GraphQL __typename ("Bot", "User"). */
export type Actor = { login: string | null; name: string | null; type: string | null };

const KNOWN_BOTS = new Set([
  "allcontributors",
  "changeset-bot",
  "codecov",
  "copilot",
  "copilot-swe-agent",
  "dependabot",
  "dependabot-preview",
  "depfu",
  "github-actions",
  "greenkeeper",
  "greenkeeperio-bot",
  "imgbot",
  "mergify",
  "pre-commit-ci",
  "release-please",
  "renovate",
  "renovate-bot",
  "semantic-release-bot",
  "snyk-bot",
  "web-flow",
  "whitesource-renovate",
]);

function isBotName(id: string): boolean {
  return (
    /\[bot\]$/i.test(id) ||
    /[-_]bot$/i.test(id) ||
    KNOWN_BOTS.has(id.toLowerCase().replace(/\[bot\]$/, ""))
  );
}

/** The one bot test used for every GitHub field. */
export function isBot(actor: Actor): boolean {
  return (
    actor.type === "Bot" ||
    [actor.login, actor.name].some((id) => id !== null && isBotName(id.trim()))
  );
}

type AuthorStats = Pick<
  GithubFacts,
  | "sampled_commits"
  | "sampled_commits_by_bots"
  | "human_committers"
  | "top_human_committer"
  | "top_human_committer_share"
  | "merged_prs_by_others_share"
>;

/** Commit authors are identified by login when GitHub links one, else by git author name. */
export function authorStats(commits: Actor[], mergedPRs: Actor[]): AuthorStats {
  const humans = commits
    .filter((author) => !isBot(author))
    .map((author) => author.login ?? author.name)
    .filter((id) => id !== null);
  const counts = new Map<string, number>();
  for (const id of humans) counts.set(id, (counts.get(id) ?? 0) + 1);
  const top = [...counts.entries()].reduce<[string, number] | null>(
    (best, entry) => (best && best[1] >= entry[1] ? best : entry),
    null,
  );

  const prAuthors = mergedPRs
    .filter((author) => !isBot(author))
    .map((author) => author.login?.toLowerCase())
    .filter((login) => login !== undefined);
  const topLogin = top?.[0].toLowerCase();

  return {
    sampled_commits: commits.length,
    sampled_commits_by_bots: commits.filter(isBot).length,
    human_committers: counts.size,
    top_human_committer: top?.[0] ?? null,
    top_human_committer_share: top ? round(top[1] / humans.length, 2) : null,
    merged_prs_by_others_share:
      top && prAuthors.length
        ? round(prAuthors.filter((login) => login !== topLogin).length / prAuthors.length, 2)
        : null,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

const totalCount = (value: unknown) => asNumber(asRecord(value).totalCount);
const nodes = (value: unknown) => asArray(asRecord(value).nodes).map(asRecord);

export async function githubFacts(
  owner: string,
  repo: string,
  token: string,
  now = Date.now(),
): Promise<GithubFacts> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "depfit",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        owner,
        repo,
        since365: new Date(now - 365 * DAY_MS).toISOString(),
        since90: new Date(now - 90 * DAY_MS).toISOString(),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GraphQL responded ${response.status}`);
  const body = asRecord(await response.json());
  const repository = asRecord(body.data).repository;
  if (!repository) {
    const error = asString(asRecord(asArray(body.errors)[0]).message);
    throw new Error(error ?? `${owner}/${repo} not found`);
  }
  const r = asRecord(repository);
  const target = asRecord(asRecord(r.defaultBranchRef).target);

  const commitAuthors = nodes(target.recent).map((commit): Actor => {
    const author = asRecord(commit.author);
    const user = asRecord(author.user);
    return {
      login: asString(user.login),
      name: asString(author.name),
      type: asString(user.__typename),
    };
  });
  const prAuthors = nodes(r.mergedPRs).map((pr): Actor => {
    const author = asRecord(pr.author);
    return { login: asString(author.login), name: null, type: asString(author.__typename) };
  });

  const closeDays = nodes(r.recentIssues).flatMap((issue) => {
    const created = asString(issue.createdAt);
    const closed = asString(issue.closedAt);
    return created && closed ? [(Date.parse(closed) - Date.parse(created)) / DAY_MS] : [];
  });
  const medianClose = median(closeDays);

  return {
    archived: typeof r.isArchived === "boolean" ? r.isArchived : null,
    stars: asNumber(r.stargazerCount),
    last_commit_at: asString(nodes(target.latest)[0]?.committedDate),
    commits_last_90d: totalCount(target.last90),
    commits_last_year: totalCount(target.recent),
    ...authorStats(commitAuthors, prAuthors),
    open_issues: totalCount(r.openIssues),
    open_prs: totalCount(r.openPRs),
    issues_median_days_to_close: medianClose === null ? null : round(medianClose, 1),
  };
}
