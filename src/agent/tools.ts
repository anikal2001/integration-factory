// The tool surface the agent drives, bound to a Sandbox. Deliberately primitive
// (read/write/list/exec/finish) so the loop is model-agnostic and portable — the same
// tools work for any model behind the ModelClient interface.

import type { ToolCall, ToolSpec } from '../model/model-client.js';
import type { Sandbox } from '../sandbox/sandbox.js';

export const toolSpecs: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a repo-relative UTF-8 file from the sandbox.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a repo-relative file in the sandbox (creates parent dirs).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List entries of a repo-relative directory in the sandbox.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'exec',
    description: 'Run a shell command in the repo root. Returns exit code, stdout, stderr.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'finish',
    description: 'End the task. Provide a short summary of what was done.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
];

export interface ToolOutcome {
  result: string;
  finished?: boolean;
  summary?: string;
}

const MAX_RESULT = 8_000;
const clip = (s: string): string => (s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '\n…[truncated]' : s);

export async function executeTool(sandbox: Sandbox, call: ToolCall): Promise<ToolOutcome> {
  const args = call.arguments;
  try {
    switch (call.name) {
      case 'read_file':
        return { result: clip(await sandbox.readFile(String(args.path))) };
      case 'write_file':
        await sandbox.writeFile(String(args.path), String(args.content));
        return { result: `wrote ${args.path}` };
      case 'list_dir':
        return { result: clip((await sandbox.listDir(String(args.path))).join('\n')) };
      case 'exec': {
        const res = await sandbox.exec(String(args.command));
        return { result: clip(`exit=${res.code}\n${res.stdout}\n${res.stderr}`) };
      }
      case 'finish':
        return { result: 'done', finished: true, summary: String(args.summary ?? '') };
      default:
        return { result: `unknown tool: ${call.name}` };
    }
  } catch (err) {
    return { result: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
