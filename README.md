# jira-mcp

MCP server for the Essent on-prem Jira (`https://jira.essent.nl/jira`). It's a single
TypeScript file that Node runs directly, so there's no build step.

Copied from `functional-services/.github/mcp/shared/jira-mcp`, where the original lives.

## Requirements

- Node 22.18 or newer (it runs `.mts` files without a build step)
- A Jira personal access token: Jira avatar → Profile → Personal access tokens → Create token

## Install

```bash
git clone <this repo> ~/Developer/jira-mcp
cd ~/Developer/jira-mcp
npm install
```

## Add to Claude Code

Available in every project (user scope):

```bash
claude mcp add jira-onprem --scope user \
  -e JIRA_TOKEN=<your-token> \
  -e JIRA_PROJECT=<default project key, optional> \
  -- node ~/Developer/jira-mcp/src/jira-mcp.mts
```

Check it with `claude mcp get jira-onprem`, or with `/mcp` inside Claude Code.

## Add to VS Code (Copilot)

In `~/Library/Application Support/Code/User/mcp.json`:

```json
{
  "servers": {
    "jira-onprem": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<you>/Developer/jira-mcp/src/jira-mcp.mts"],
      "env": { "JIRA_TOKEN": "<your-token>" }
    }
  }
}
```

## Environment variables

Required:

- `JIRA_TOKEN`: your Jira personal access token

Optional defaults (you can still override them per call):

- `JIRA_PROJECT`: default project key
- `JIRA_AGILE_TEAM`: Agile Team (`customfield_10024`)
- `JIRA_AGILE_RELEASE_TRAIN`: Agile Release Train (`customfield_17032`), for issues only
- `JIRA_INVOLVED_APPLICATIONS`: Involved Applications (`customfield_16230`)
- `JIRA_LABELS`: comma-separated default labels, for issues only

## Available Tools

### `jira_myself`

Check Jira authentication by calling the `/myself` endpoint.

### `jira_get_issue`

Get detailed information about a Jira issue.

**Parameters**:

- `issueKey` (required): The issue key (e.g., "PROJ-123")

**Returns**: Complete issue details including:

- Summary, description, status
- Issue type, priority, labels
- Reporter, assignee
- Created/updated timestamps
- Custom fields
- Comments, attachments, subtasks
- Links to other issues

**Example**:

```

Get details for TI-118

```

### `jira_search_issues`

Search issues by free text and/or JQL.

**Parameters**:

- `text` (optional): Text to search for, in Lucene syntax (`"exact phrase"`, `cost*`)
- `field` (optional): `text` (default; covers summary, description and comments), `description`, `summary` or `comment`
- `projectKey` (optional): Limits the search to one project; leave it out to search every project
- `jql` (optional): Raw JQL, combined with the filters above using AND. Its `ORDER BY` is kept
- `maxResults` (optional): 1–100, default 20

At least one of `text`, `projectKey` or `jql` is required. Results are sorted by `updated DESC` unless the JQL has its own `ORDER BY`.

**Returns**: The total number of hits, the JQL that ran, and one line per issue with key, type, status, assignee, last-updated date and summary.

**Example**:

```

Find TI tickets whose description mentions "friendly users"

```

### `jira_create_issue`

Create a new Jira issue.

**Parameters**:

- `projectKey` (optional if `JIRA_PROJECT` env var is set): The project key (e.g., "PROJ")
- `issueType` (optional): Issue type name (default: "User Story")
- `summary` (required): Issue summary/title
- `description` (optional): Issue description
- `epicLink` (optional): Epic issue key to link this issue to (e.g., "IPA-521"). Works cross-project. The correct custom field is probed automatically.
- `customFields` (optional): Custom fields as key-value pairs (e.g., `{"customfield_10024": [{"value": "Team Name"}]}`)

**Example**:

```

Create a User Story in project TI for epic IPA-521 with summary "Implement end of netting for Flexible product model"

```

### `jira_update_issue`

Update fields on an existing Jira issue.

**Parameters**:

- `issueKey` (required): The issue key to update (e.g., "TI-605")
- `summary` (optional): New summary
- `description` (optional): New description
- `epicLink` (optional): Epic issue key to link this issue to (e.g., "IPA-521")
- `customFields` (optional): Fields to update as key-value pairs

**Example**:

```

Link TI-605 to epic IPA-521

```

### `jira_create_subtask`

Create a subtask for an existing Jira issue.

**Parameters**:

- `parentIssueKey` (required): The parent issue key (e.g., "PROJ-123")
- `summary` (required): Subtask summary/title
- `description` (optional): Subtask description
- `customFields` (optional): Custom fields as key-value pairs (note: not all parent fields are available on subtasks)

**Example**:

```

Create a subtask for PROJ-123 with summary "Update documentation"

```

### `jira_get_transitions`

Get available workflow transitions for a Jira issue.

**Parameters**:

- `issueKey` (required): The issue key (e.g., "PROJ-123")

**Example**:

```

What transitions are available for PROJ-123?

```

### `jira_transition_issue`

Transition a Jira issue to a new workflow state.

**Parameters**:

- `issueKey` (required): The issue key (e.g., "PROJ-123")
- `transitionName` (required): Name of the transition (e.g., "Reject", "Done", "Start Building")

**Example**:

```

Transition PROJ-123 to Rejected

```

### `jira_link_issues`

Link two issues so that `<issueKey> <phrase> <linkedIssueKey>` reads correctly.

**Parameters**:

- `issueKey` (required): The issue the link reads from (e.g., "TI-1304")
- `linkType` (required): A link type name (e.g., "Dependency", "Blocked", "Related") or one of its phrases (e.g., "depends on", "is required for", "blocks", "is blocked by"). A type name uses its outward phrase, so "Dependency" means "depends on"
- `linkedIssueKey` (required): The issue the link points to (e.g., "TI-1367")

An unknown link type returns the list of available types with both phrases. `jira_get_issue` shows each link with its phrase, e.g. `Dependency (depends on): TI-1367`.

**Example**:

```

TI-1304 depends on TI-1367

```

