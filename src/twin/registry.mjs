// Every supported service: one import per file in ./services/.
import emulate from './services/emulate.mjs';
import llm from './services/llm.mjs';
import mailpit from './services/mailpit.mjs';
import mongodb from './services/mongodb.mjs';
import postgres from './services/postgres.mjs';
import redis from './services/redis.mjs';
import secrets from './services/secrets.mjs';
import stripe from './services/stripe.mjs';
import supabase from './services/supabase.mjs';
import triggerDev from './services/trigger-dev.mjs';

const list = [postgres, redis, mongodb, mailpit, llm, secrets, supabase, stripe, triggerDev, emulate];

export const services = Object.freeze(Object.fromEntries(list.map(service => [service.id, service])));
if (Object.keys(services).length !== list.length) throw new Error('Twin service ids must be unique.');
