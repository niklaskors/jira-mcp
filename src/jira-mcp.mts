import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = 'https://jira.essent.nl/jira';
const token = process.env.JIRA_TOKEN;
const defaultProject = process.env.JIRA_PROJECT;
const defaultAgileTeam = process.env.JIRA_AGILE_TEAM;
const defaultAgileReleaseTrainValue = process.env.JIRA_AGILE_RELEASE_TRAIN;
const defaultInvolvedApplications = process.env.JIRA_INVOLVED_APPLICATIONS;
const defaultLabels = (process.env.JIRA_LABELS ?? '')
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean);

if (!token) throw new Error('Missing JIRA_TOKEN');

// Schema definitions
const createIssueSchema = z.object({
  projectKey: z.string().optional(),
  issueType: z.string().default('User Story'),
  summary: z.string(),
  description: z.string().optional(),
  epicLink: z.string().optional().describe('Epic issue key to link this issue to (e.g., IPA-521)'),
  customFields: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Optional custom fields as key-value pairs (e.g., {'customfield_10024': 'Team Name'})"
    ),
});

const updateIssueSchema = z.object({
  issueKey: z.string().describe('Issue key to update (e.g., TI-605)'),
  summary: z.string().optional(),
  description: z.string().optional(),
  epicLink: z.string().optional().describe('Epic issue key to link this issue to (e.g., IPA-521)'),
  customFields: z
    .record(z.string(), z.any())
    .optional()
    .describe('Fields to update as key-value pairs'),
});

const createSubtaskSchema = z.object({
  parentIssueKey: z.string().describe('Parent issue key (e.g., PROJ-123)'),
  summary: z.string().describe('Subtask summary/title'),
  description: z.string().optional().describe('Subtask description'),
  customFields: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Optional custom fields as key-value pairs (e.g., {'customfield_10024': 'Team Name'})"
    ),
});

const getIssueSchema = z.object({
  issueKey: z.string().describe('Issue key (e.g., PROJ-123)'),
});

const searchIssuesSchema = z.object({
  text: z
    .string()
    .optional()
    .describe('Free text to search for (Lucene syntax, e.g. "friendly users" or cost*)'),
  field: z
    .enum(['text', 'description', 'summary', 'comment'])
    .default('text')
    .describe("Field to match `text` against; 'text' covers summary, description and comments"),
  projectKey: z.string().optional().describe('Restrict to a project (e.g., TI); omit for all'),
  jql: z
    .string()
    .optional()
    .describe('Raw JQL; combined with `text`/`projectKey` using AND when those are also given'),
  maxResults: z.number().int().min(1).max(100).default(20),
});

const getTransitionsSchema = z.object({
  issueKey: z.string().describe('Issue key (e.g., PROJ-123)'),
});

const transitionIssueSchema = z.object({
  issueKey: z.string().describe('Issue key (e.g., PROJ-123)'),
  transitionName: z.string().describe("Name of the transition (e.g., 'Reject', 'Done')"),
});

const linkIssuesSchema = z.object({
  issueKey: z.string().describe('Issue the link reads from (e.g., TI-1304)'),
  linkType: z
    .string()
    .describe(
      "Link type name or one of its directional phrases (e.g., 'Dependency', 'depends on', 'is required for', 'blocks', 'Related'). A type name uses its outward phrase."
    ),
  linkedIssueKey: z.string().describe('Issue the link points to (e.g., TI-1367)'),
});

/** Epic link custom field for Essent on-prem Jira. */
const EPIC_LINK_FIELD = 'customfield_11532';

const server = new McpServer({
  name: 'jira-onprem',
  version: '0.1.0',
});

server.registerTool(
  'jira_myself',
  {
    description: 'Check Jira auth by calling /myself',
  },
  async () => {
    const res = await fetch(`${baseUrl}/rest/api/2/myself`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }],
      };
    }

    return {
      content: [{ type: 'text' as const, text }],
    };
  }
);

server.registerTool(
  'jira_create_issue',
  {
    description: 'Create Jira issue',
    inputSchema: createIssueSchema,
  },
  async (args: z.infer<typeof createIssueSchema>) => {
    const { projectKey, issueType, summary, description, epicLink, customFields } = args;
    // Use default project if not provided
    const finalProjectKey = projectKey || defaultProject;
    if (!finalProjectKey) {
      throw new Error('projectKey is required when JIRA_PROJECT environment variable is not set');
    }

    // Build default custom fields from environment variables if not provided
    const defaultCustomFields: Record<string, any> = {};
    if (defaultAgileTeam) {
      defaultCustomFields['customfield_10024'] = [{ value: defaultAgileTeam }];
    }
    if (defaultAgileReleaseTrainValue) {
      defaultCustomFields['customfield_17032'] = [{ value: defaultAgileReleaseTrainValue }];
    }
    if (defaultInvolvedApplications) {
      defaultCustomFields['customfield_16230'] = [{ value: defaultInvolvedApplications }];
    }
    if (defaultLabels.length > 0) {
      defaultCustomFields['labels'] = defaultLabels;
    }

    // Merge default custom fields with provided ones (provided ones take precedence)
    const mergedCustomFields = {
      ...defaultCustomFields,
      ...(customFields || {}),
    };

    // Include epic link field if provided
    if (epicLink) {
      mergedCustomFields[EPIC_LINK_FIELD] = epicLink;
    }

    const issueFields = {
      project: { key: finalProjectKey },
      issuetype: { name: issueType },
      summary,
      ...(description ? { description } : {}),
      ...mergedCustomFields,
    };

    const res = await fetch(`${baseUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: issueFields }),
    });
    const text = await res.text();
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `HTTP error: ${text}` }] };
    }

    const createdKey: string = JSON.parse(text).key;

    return {
      content: [
        { type: 'text' as const, text: `Created ${createdKey}: ${baseUrl}/browse/${createdKey}` },
      ],
    };
  }
);

server.registerTool(
  'jira_update_issue',
  {
    description:
      'Update fields on an existing Jira issue (summary, description, epicLink, custom fields)',
    inputSchema: updateIssueSchema,
  },
  async (args: z.infer<typeof updateIssueSchema>) => {
    const { issueKey, summary, description, epicLink, customFields } = args;

    const fieldsToUpdate: Record<string, any> = {};
    if (summary) fieldsToUpdate['summary'] = summary;
    if (description) fieldsToUpdate['description'] = description;
    if (epicLink) fieldsToUpdate[EPIC_LINK_FIELD] = epicLink;
    if (customFields) Object.assign(fieldsToUpdate, customFields);

    if (Object.keys(fieldsToUpdate).length > 0) {
      const res = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: fieldsToUpdate }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text' as const, text: `HTTP error: ${text}` }] };
      }
    }

    return { content: [{ type: 'text' as const, text: `Updated ${issueKey} successfully.` }] };
  }
);

server.registerTool(
  'jira_create_subtask',
  {
    description: 'Create a subtask for an existing Jira issue',
    inputSchema: createSubtaskSchema,
  },
  async (args: z.infer<typeof createSubtaskSchema>) => {
    const { parentIssueKey, summary, description, customFields } = args;
    // Extract project key from parent issue key (e.g., "TI-442" -> "TI")
    const projectKey = parentIssueKey.split('-')[0];

    // Build default custom fields from environment variables if not provided
    // Note: Subtasks may have different available fields than parent issues
    const defaultCustomFields: Record<string, any> = {};
    if (defaultAgileTeam) {
      defaultCustomFields['customfield_10024'] = [{ value: defaultAgileTeam }];
    }
    // Note: customfield_17032 (Agile Release Train) and customfield_16230 (Involved Applications) are typically not available on subtasks

    // Merge default custom fields with provided ones (provided ones take precedence)
    const mergedCustomFields = {
      ...defaultCustomFields,
      ...(customFields || {}),
    };

    const issueFields = {
      project: { key: projectKey },
      parent: { key: parentIssueKey },
      issuetype: { name: 'Subtask' },
      summary,
      ...(description ? { description } : {}),
      ...mergedCustomFields,
    };

    const subtaskRes = await fetch(`${baseUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: issueFields }),
    });
    const subtaskText = await subtaskRes.text();
    if (!subtaskRes.ok) {
      return { content: [{ type: 'text' as const, text: `HTTP error: ${subtaskText}` }] };
    }

    const resultKey = JSON.parse(subtaskText).key;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Created ${resultKey}: https://jira.essent.nl/jira/browse/${resultKey}`,
        },
      ],
    };
  }
);

server.registerTool(
  'jira_get_issue',
  {
    description: 'Get detailed information about a Jira issue',
    inputSchema: getIssueSchema,
  },
  async (args: z.infer<typeof getIssueSchema>) => {
    const { issueKey } = args;
    const res = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }],
      };
    }

    const issue = await res.json();
    const fields = issue.fields;

    // Format the issue details in a readable way
    const formattedOutput: string[] = [];

    // Basic Information
    formattedOutput.push(`# ${issue.key}: ${fields.summary}`);
    formattedOutput.push('');
    formattedOutput.push('## Basic Information');
    formattedOutput.push(`- **Type:** ${fields.issuetype?.name || 'N/A'}`);
    formattedOutput.push(`- **Status:** ${fields.status?.name || 'N/A'}`);
    formattedOutput.push(`- **Priority:** ${fields.priority?.name || 'N/A'}`);
    formattedOutput.push(
      `- **Project:** ${fields.project?.name || 'N/A'} (${fields.project?.key || 'N/A'})`
    );
    formattedOutput.push('');

    // People
    formattedOutput.push('## People');
    formattedOutput.push(`- **Assignee:** ${fields.assignee?.displayName || 'Unassigned'}`);
    formattedOutput.push(`- **Reporter:** ${fields.reporter?.displayName || 'N/A'}`);
    formattedOutput.push('');

    // Dates
    formattedOutput.push('## Dates');
    if (fields.created) {
      formattedOutput.push(`- **Created:** ${new Date(fields.created).toLocaleString()}`);
    }
    if (fields.updated) {
      formattedOutput.push(`- **Updated:** ${new Date(fields.updated).toLocaleString()}`);
    }
    if (fields.resolutiondate) {
      formattedOutput.push(`- **Resolved:** ${new Date(fields.resolutiondate).toLocaleString()}`);
    }
    formattedOutput.push('');

    // Key Custom Fields (common ones)
    const customFieldsSection: string[] = [];

    // Agile Team (customfield_10024)
    if (
      fields.customfield_10024 &&
      Array.isArray(fields.customfield_10024) &&
      fields.customfield_10024.length > 0
    ) {
      const teams = fields.customfield_10024.map((t: any) => t.value).join(', ');
      customFieldsSection.push(`- **Agile Team:** ${teams}`);
    }

    // Agile Release Train (customfield_17032)
    if (
      fields.customfield_17032 &&
      Array.isArray(fields.customfield_17032) &&
      fields.customfield_17032.length > 0
    ) {
      const arts = fields.customfield_17032.map((t: any) => t.value).join(', ');
      customFieldsSection.push(`- **Agile Release Train:** ${arts}`);
    }

    // Story Points (customfield_10002)
    if (fields.customfield_10002) {
      customFieldsSection.push(`- **Story Points:** ${fields.customfield_10002}`);
    }

    // Sprint (customfield_10020)
    if (
      fields.customfield_10020 &&
      Array.isArray(fields.customfield_10020) &&
      fields.customfield_10020.length > 0
    ) {
      const sprints = fields.customfield_10020
        .map((s: any) => s.name)
        .filter(Boolean)
        .join(', ');
      if (sprints) {
        customFieldsSection.push(`- **Sprint:** ${sprints}`);
      }
    }

    if (customFieldsSection.length > 0) {
      formattedOutput.push('## Key Custom Fields');
      formattedOutput.push(...customFieldsSection);
      formattedOutput.push('');
    }

    // Description
    if (fields.description) {
      formattedOutput.push('## Description');
      formattedOutput.push(fields.description);
      formattedOutput.push('');
    }

    // Labels
    if (fields.labels && fields.labels.length > 0) {
      formattedOutput.push('## Labels');
      formattedOutput.push(fields.labels.join(', '));
      formattedOutput.push('');
    }

    // Subtasks
    if (fields.subtasks && fields.subtasks.length > 0) {
      formattedOutput.push('## Subtasks');
      fields.subtasks.forEach((subtask: any) => {
        formattedOutput.push(
          `- ${subtask.key}: ${subtask.fields?.summary || 'N/A'} [${subtask.fields?.status?.name || 'N/A'}]`
        );
      });
      formattedOutput.push('');
    }

    // Issue Links
    if (fields.issuelinks && fields.issuelinks.length > 0) {
      formattedOutput.push('## Linked Issues');
      fields.issuelinks.forEach((link: any) => {
        const linkType = link.type?.name || 'Unknown';
        if (link.outwardIssue) {
          formattedOutput.push(
            `- ${linkType} (${link.type?.outward}): ${link.outwardIssue.key} - ${link.outwardIssue.fields?.summary || 'N/A'}`
          );
        } else if (link.inwardIssue) {
          formattedOutput.push(
            `- ${linkType} (${link.type?.inward}): ${link.inwardIssue.key} - ${link.inwardIssue.fields?.summary || 'N/A'}`
          );
        }
      });
      formattedOutput.push('');
    }

    // Comments
    if (fields.comment?.comments && fields.comment.comments.length > 0) {
      formattedOutput.push('## Comments');
      fields.comment.comments.forEach((comment: any) => {
        const author = comment.author?.displayName || 'Unknown';
        const date = comment.created ? new Date(comment.created).toLocaleString() : 'Unknown date';
        formattedOutput.push(`### ${author} - ${date}`);
        formattedOutput.push(comment.body);
        formattedOutput.push('');
      });
    }

    // Attachments
    if (fields.attachment && fields.attachment.length > 0) {
      formattedOutput.push('## Attachments');
      fields.attachment.forEach((att: any) => {
        const size = att.size ? `(${Math.round(att.size / 1024)} KB)` : '';
        formattedOutput.push(`- ${att.filename} ${size} - ${att.content}`);
      });
      formattedOutput.push('');
    }

    // Fix Versions
    if (fields.fixVersions && fields.fixVersions.length > 0) {
      formattedOutput.push('## Fix Versions');
      formattedOutput.push(fields.fixVersions.map((v: any) => v.name).join(', '));
      formattedOutput.push('');
    }

    // Components
    if (fields.components && fields.components.length > 0) {
      formattedOutput.push('## Components');
      formattedOutput.push(fields.components.map((c: any) => c.name).join(', '));
      formattedOutput.push('');
    }

    // Link to issue
    formattedOutput.push('---');
    formattedOutput.push(`**View in Jira:** ${baseUrl}/browse/${issue.key}`);

    return { content: [{ type: 'text' as const, text: formattedOutput.join('\n') }] };
  }
);

server.registerTool(
  'jira_search_issues',
  {
    description: 'Search Jira issues by free text (description, summary, comments) and/or raw JQL',
    inputSchema: searchIssuesSchema,
  },
  async (args: z.infer<typeof searchIssuesSchema>) => {
    const { text, field, projectKey, jql, maxResults } = args;

    // ORDER BY cannot live inside a parenthesised clause, so split it off the raw JQL
    const [jqlFilter, jqlOrderBy] = (jql ?? '').split(/\border\s+by\b/i).map((s) => s.trim());

    const clauses: string[] = [];
    if (projectKey) clauses.push(`project = "${projectKey}"`);
    if (text) clauses.push(`${field} ~ "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    if (jqlFilter) clauses.push(`(${jqlFilter})`);
    if (clauses.length === 0) {
      throw new Error('Provide at least one of text, projectKey or jql');
    }
    const finalJql = `${clauses.join(' AND ')} ORDER BY ${jqlOrderBy || 'updated DESC'}`;

    const params = new URLSearchParams({
      jql: finalJql,
      maxResults: String(maxResults),
      fields: 'summary,status,issuetype,assignee,updated',
    });
    const res = await fetch(`${baseUrl}/rest/api/2/search?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        content: [
          { type: 'text' as const, text: `HTTP ${res.status}: ${errorText}\nJQL: ${finalJql}` },
        ],
      };
    }

    const data = await res.json();
    const lines: string[] = [
      `Found ${data.total} issue(s), showing ${data.issues.length}. JQL: ${finalJql}`,
      '',
    ];
    data.issues.forEach((issue: any) => {
      const f = issue.fields;
      const updated = f.updated ? new Date(f.updated).toISOString().slice(0, 10) : 'N/A';
      lines.push(
        `- ${issue.key} [${f.issuetype?.name || 'N/A'} | ${f.status?.name || 'N/A'} | ${f.assignee?.displayName || 'Unassigned'} | updated ${updated}]: ${f.summary}`
      );
    });

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'jira_get_transitions',
  {
    description: 'Get available transitions for a Jira issue',
    inputSchema: getTransitionsSchema,
  },
  async (args: z.infer<typeof getTransitionsSchema>) => {
    const { issueKey } = args;
    const res = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}/transitions`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }],
      };
    }

    return { content: [{ type: 'text' as const, text }] };
  }
);

server.registerTool(
  'jira_transition_issue',
  {
    description: 'Transition a Jira issue to a new state (e.g., Rejected, Done, In Progress)',
    inputSchema: transitionIssueSchema,
  },
  async (args: z.infer<typeof transitionIssueSchema>) => {
    const { issueKey, transitionName } = args;
    // First get available transitions
    const transitionsRes = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}/transitions`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!transitionsRes.ok) {
      const text = await transitionsRes.text();
      return {
        content: [{ type: 'text' as const, text: `HTTP ${transitionsRes.status}: ${text}` }],
      };
    }

    const transitionsData = await transitionsRes.json();
    const transition = transitionsData.transitions.find(
      (t: any) => t.name.toLowerCase() === transitionName.toLowerCase()
    );

    if (!transition) {
      const available = transitionsData.transitions.map((t: any) => t.name).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Transition '${transitionName}' not found. Available: ${available}`,
          },
        ],
      };
    }

    // Perform the transition
    const res = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}/transitions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transition: { id: transition.id } }),
    });

    if (res.status === 204) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully transitioned ${issueKey} to ${transitionName}`,
          },
        ],
      };
    }

    const text = await res.text();
    return {
      content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }],
    };
  }
);

server.registerTool(
  'jira_link_issues',
  {
    description:
      "Link two Jira issues so that '<issueKey> <phrase> <linkedIssueKey>' reads correctly (e.g., TI-1304 depends on TI-1367)",
    inputSchema: linkIssuesSchema,
  },
  async (args: z.infer<typeof linkIssuesSchema>) => {
    const { issueKey, linkType, linkedIssueKey } = args;
    const typesRes = await fetch(`${baseUrl}/rest/api/2/issueLinkType`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!typesRes.ok) {
      const text = await typesRes.text();
      return {
        content: [{ type: 'text' as const, text: `HTTP ${typesRes.status}: ${text}` }],
      };
    }

    const types: { name: string; inward: string; outward: string }[] = (await typesRes.json())
      .issueLinkTypes;
    const wanted = linkType.toLowerCase();
    const byName = types.find((t) => t.name.toLowerCase() === wanted);
    const byOutward = types.find((t) => t.outward.toLowerCase() === wanted);
    const byInward = types.find((t) => t.inward.toLowerCase() === wanted);
    const type = byName ?? byOutward ?? byInward;

    if (!type) {
      const available = types.map((t) => `${t.name} (${t.outward} / ${t.inward})`).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Link type '${linkType}' not found. Available: ${available}`,
          },
        ],
      };
    }

    // Jira shows the outward phrase on the issue sent as inwardIssue, so issueKey goes there
    // for an outward phrase and the two keys swap for an inward phrase.
    const readsInward = !byName && !byOutward;
    const [inwardKey, outwardKey] = readsInward
      ? [linkedIssueKey, issueKey]
      : [issueKey, linkedIssueKey];

    const res = await fetch(`${baseUrl}/rest/api/2/issueLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: { name: type.name },
        inwardIssue: { key: inwardKey },
        outwardIssue: { key: outwardKey },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }],
      };
    }

    const phrase = readsInward ? type.inward : type.outward;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Linked: ${issueKey} ${phrase} ${linkedIssueKey} (${type.name})`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
