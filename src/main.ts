import * as core from "@actions/core";
import * as github from "@actions/github";
import * as yaml from "js-yaml";
import { Minimatch, IMinimatch } from "minimatch";

interface MatchConfig {
  all?: string[];
  any?: string[];
}

type StringOrMatchConfig = string | MatchConfig;

async function run() {
  try {
    const token = core.getInput("repo-token", { required: true });
    const configPath = core.getInput("configuration-path", { required: true });
    const syncLabels = !!core.getInput("sync-labels", { required: false });

    const prNumber = getPrNumber();
    
    if (!prNumber) {
      console.log(github.context);
      console.error("Could not get pull request number from context, exiting");
      return;
    }


    const octokit = github.getOctokit(token);

    console.log(octokit);

    const repo = octokit.context.repo;
    const { data: pullRequest } = await octokit.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
    });

    core.debug("Getting changed files for PR #${prNumber}");

    const changedFiles: string[] = await getChangedFiles(octokit, prNumber);

    const labelGlobs: Map<string, StringOrMatchConfig[]> = await getLabelGlobs(
        octokit,
        configPath
    );

    const labels: string[] = [];
    const labelsToRemove: string[] = [];





  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function getPrNumber(): number | undefined {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return undefined;
  }

  return pullRequest.number;
}

async function getChangedFiles(
  client,
  prNumber: number
): Promise<string[]> {
  const listFilesOptions = client.pulls.listFiles.endpoint.merge({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
  });

  const listFilesResponse = await client.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map((f) => f.filename);

  core.debug("found changed files:");
  for (const file of changedFiles) {
    core.debug("  " + file);
  }

  return changedFiles;
}

async function getLabelGlobs(
    client,
    configurationPath: string
  ): Promise<Map<string, StringOrMatchConfig[]>> {
    const configurationContent: string = await fetchContent(
      client,
      configurationPath
    );
  
    // loads (hopefully) a `{[label:string]: string | StringOrMatchConfig[]}`, but is `any`:
    const configObject: any = yaml.safeLoad(configurationContent);
  
    // transform `any` => `Map<string,StringOrMatchConfig[]>` or throw if yaml is malformed:
    return getLabelGlobMapFromObject(configObject);
  }

  async function fetchContent(
    client,
    repoPath: string
  ): Promise<string> {
    const response: any = await client.repos.getContents({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: repoPath,
      ref: github.context.sha
    });
  
    return Buffer.from(response.data.content, response.data.encoding).toString();
  }
  
  function getLabelGlobMapFromObject(
    configObject: any
  ): Map<string, StringOrMatchConfig[]> {
    const labelGlobs: Map<string, StringOrMatchConfig[]> = new Map();
    for (const label in configObject) {
      if (typeof configObject[label] === "string") {
        labelGlobs.set(label, [configObject[label]]);
      } else if (configObject[label] instanceof Array) {
        labelGlobs.set(label, configObject[label]);
      } else {
        throw Error(
          `found unexpected type for label ${label} (should be string or array of globs)`
        );
      }
    }
  
    return labelGlobs;
  }
  
  function toMatchConfig(config: StringOrMatchConfig): MatchConfig {
    if (typeof config === "string") {
      return {
        any: [config]
      };
    }
  
    return config;
  }
  
  function printPattern(matcher: IMinimatch): string {
    return (matcher.negate ? "!" : "") + matcher.pattern;
  }
  
  function checkGlobs(
    changedFiles: string[],
    globs: StringOrMatchConfig[]
  ): boolean {
    for (const glob of globs) {
      core.debug(` checking pattern ${JSON.stringify(glob)}`);
      const matchConfig = toMatchConfig(glob);
      if (checkMatch(changedFiles, matchConfig)) {
        return true;
      }
    }
    return false;
  }
  
  function isMatch(changedFile: string, matchers: IMinimatch[]): boolean {
    core.debug(`    matching patterns against file ${changedFile}`);
    for (const matcher of matchers) {
      core.debug(`   - ${printPattern(matcher)}`);
      if (!matcher.match(changedFile)) {
        core.debug(`   ${printPattern(matcher)} did not match`);
        return false;
      }
    }
  
    core.debug(`   all patterns matched`);
    return true;
  }
  
  // equivalent to "Array.some()" but expanded for debugging and clarity
  function checkAny(changedFiles: string[], globs: string[]): boolean {
    const matchers = globs.map(g => new Minimatch(g));
    core.debug(`  checking "any" patterns`);
    for (const changedFile of changedFiles) {
      if (isMatch(changedFile, matchers)) {
        core.debug(`  "any" patterns matched against ${changedFile}`);
        return true;
      }
    }
  
    core.debug(`  "any" patterns did not match any files`);
    return false;
  }
  
  // equivalent to "Array.every()" but expanded for debugging and clarity
  function checkAll(changedFiles: string[], globs: string[]): boolean {
    const matchers = globs.map(g => new Minimatch(g));
    core.debug(` checking "all" patterns`);
    for (const changedFile of changedFiles) {
      if (!isMatch(changedFile, matchers)) {
        core.debug(`  "all" patterns did not match against ${changedFile}`);
        return false;
      }
    }
  
    core.debug(`  "all" patterns matched all files`);
    return true;
  }
  
  function checkMatch(changedFiles: string[], matchConfig: MatchConfig): boolean {
    if (matchConfig.all !== undefined) {
      if (!checkAll(changedFiles, matchConfig.all)) {
        return false;
      }
    }
  
    if (matchConfig.any !== undefined) {
      if (!checkAny(changedFiles, matchConfig.any)) {
        return false;
      }
    }
  
    return true;
  }
  
  async function addLabels(
    client,
    prNumber: number,
    labels: string[]
  ) {
    await client.issues.addLabels({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      labels: labels
    });
  }
  
  async function removeLabels(
    client,
    prNumber: number,
    labels: string[]
  ) {
    await Promise.all(
      labels.map(label =>
        client.issues.removeLabel({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: prNumber,
          name: label
        })
      )
    );
  }
  
  console.log("Running");

  run();