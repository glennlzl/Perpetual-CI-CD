// Every supported service: one import per file in ./services/.
import type { Json, JsonObject } from './config.ts';
import emulate from './services/emulate.ts';
import llm from './services/llm.ts';
import mailpit from './services/mailpit.ts';
import mongodb from './services/mongodb.ts';
import postgres from './services/postgres.ts';
import redis from './services/redis.ts';
import secrets from './services/secrets.ts';
import stripe from './services/stripe.ts';
import supabase from './services/supabase.ts';
import triggerDev from './services/trigger-dev.ts';

/** Where a service's stand-in comes from, recorded with run results. */
export type Fidelity = 'actual' | 'official-sandbox' | 'emulate';
/** A detection pattern: an exact name (or, for files, a path suffix) or an expression. */
export type Pattern = string | RegExp;
export type CommandOutput = { stdout: string; stderr?: string };
/** docker(args, { timeoutMs }) -> { stdout, stderr }, for a provision. */
export type DockerCommand = (args: string[], options?: { timeoutMs?: number }) => Promise<CommandOutput>;
/** Variables as a service returns them: empty values are dropped, the rest become text. */
export type EnvInput = Record<string, string | number | boolean | null | undefined>;
/** Input values of one service by input name. */
export type InputValues = Record<string, string>;
export type ServiceOutputs = Record<string, unknown>;

/** A value the user supplies, e.g. a test key; `pattern` checks its format. */
export interface ServiceInput { name: string; label?: string; pattern?: Pattern; secret?: boolean; optional?: boolean; help?: string }
export interface ProvisionInput { name: string; label?: string; default?: string }
/** What a provision returns; the store checks it like a manual save. */
export interface ProvisionResult { values?: Record<string, string | undefined>; details?: { expiresAt?: string; claimUrl?: string; account?: string } }
export interface ServiceProvision {
  inputs: ProvisionInput[];
  run(options: { inputs: InputValues; docker: DockerCommand; tempDir: string }): Promise<ProvisionResult | undefined>;
}
export interface ContainerHealth { http?: { port: number | string; path?: string }; command?: string | string[] }
/** One container of a service; `directory` runs it in that snapshot directory, like an app. */
export interface ServiceContainer {
  name: string; image: string; command?: string | string[]; env?: EnvInput; ports?: Record<string, number>; health?: ContainerHealth; directory?: string;
}

/**
 * A service's options as a twin config gives them: the config checks only that they form an object of JSON values, so
 * each field is any JSON value, which the service narrows where it uses it (./options.ts). A narrower field type would
 * claim a check nothing made, and does not satisfy this.
 */
export type ServiceOptions<Options> = { [K in keyof Options]: Json extends Exclude<Options[K], undefined> ? Options[K] : never };
/** What each service function receives from the twin runtime. */
export interface ServiceContext<Options extends ServiceOptions<Options> = JsonObject, Outputs = ServiceOutputs> {
  options: Options; inputs: InputValues; outputs: Outputs;
  host: string; project: string; dir: string; shared: string; source: string;
  port(name: string): number;
  url(name: string, path?: string): string;
  sharedPort(name: string, current?: unknown): Promise<number>;
  app(id: string): { url: string; port: number };
  run(image: string, args: string[], options?: { env?: EnvInput }): Promise<CommandOutput>;
  exec(file: string, args: string[], options?: { cwd?: string }): Promise<CommandOutput>;
  /** Tests supply their own; services otherwise use the global fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** A service definition. Its functions are methods, so a service with its own Options and Outputs is still a TwinService. */
export interface TwinService<Options extends ServiceOptions<Options> = JsonObject, Outputs = ServiceOutputs> {
  id: string; title: string; fidelity: Fidelity;
  detect?: { files?: Pattern[]; packages?: Pattern[]; env?: Pattern[] };
  /** Services this one supplies itself, e.g. a local stack with its own database. */
  includes?: string[];
  inputs?: ServiceInput[];
  provision?: ServiceProvision;
  checklist?: { id: string; title: string; url: string }[];
  setup?(ctx: ServiceContext<Options, Outputs>): Promise<Outputs>;
  containers?(ctx: ServiceContext<Options, Outputs>): ServiceContainer[];
  env(ctx: ServiceContext<Options, Outputs>): EnvInput;
  /** Test accounts, checked by the runtime before they are stored. */
  accounts?(ctx: ServiceContext<Options, Outputs>): Promise<unknown>;
  teardown?(ctx: ServiceContext<Options, Outputs>): Promise<void>;
}
export type TwinServices = Readonly<Record<string, TwinService>>;

const list: TwinService[] = [postgres, redis, mongodb, mailpit, llm, secrets, supabase, stripe, triggerDev, emulate];

export const services: TwinServices = Object.freeze(Object.fromEntries(list.map(service => [service.id, service])));
if (Object.keys(services).length !== list.length) throw new Error('Twin service ids must be unique.');
