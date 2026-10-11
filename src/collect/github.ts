/** GitHub GraphQL facts about a package's repository. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Maintenance } from "../report.ts";
import { asArray, asNumber, asRecord, asString, DAY_MS } from "./util.ts";

const run = promisify(execFile);

export type GithubFacts = Pick<Maintenance, "archived" | "last_commit_at" | "commits_last_year">;

export const NO_GITHUB: GithubFacts = {
  archived: null,
  last_commit_at: null,
  commits_last_year: null,
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

// `latest` is queried separately: `year` is filtered by `since`, so its first node is not
// necessarily the newest commit.
const QUERY = `
query($owner: String!, $repo: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $repo) {
    isArchived
    defaultBranchRef {
      target {
        ... on Commit {
          year: history(since: $since) { totalCount }
          latest: history(first: 1) { nodes { committedDate } }
        }
      }
    }
  }
}`;

/** One GraphQL request; throws on HTTP errors or when the repository is not found. */
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
      variables: { owner, repo, since: new Date(now - 365 * DAY_MS).toISOString() },
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
  const latest = asRecord(asArray(asRecord(target.latest).nodes)[0]);

  return {
    archived: typeof r.isArchived === "boolean" ? r.isArchived : null,
    last_commit_at: asString(latest.committedDate),
    commits_last_year: asNumber(asRecord(target.year).totalCount),
  };
}
