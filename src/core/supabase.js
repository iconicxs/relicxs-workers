/**
 * Shared Supabase client and RPC wrapper.
 */
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const { logger } = require('./logger');

// Prefer service role if provided; fallback to service key
const supabaseKey = config.supabase.serviceRole || config.supabase.serviceKey;
if (!supabaseKey) {
  throw new Error('[SUPABASE] Missing service key/role: set SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE');
}

const supabase = createClient(config.supabase.url, supabaseKey, {
	auth: { persistSession: false },
});

/**
 * Call a Postgres function via Supabase RPC with consistent error handling.
 * @param {{ name: string, params?: Record<string, any>, tenantId?: string }} args
 */
async function callRpc({ name, params = {}, tenantId }) {
	const log = logger.child({ component: 'supabase-rpc', rpc: name, tenantId });
	const finalParams = { ...params };
	if (tenantId && finalParams.tenant_id == null) finalParams.tenant_id = tenantId;
	try {
		const { data, error } = await supabase.rpc(name, finalParams);
		if (error) {
			log.error({ error }, 'Supabase RPC failed');
			throw new Error(`[SUPABASE_RPC_ERROR] ${name}: ${error.message}`);
		}
		log.debug('Supabase RPC success');
		return data;
	} catch (err) {
		if (!(err instanceof Error)) {
			throw new Error(`[SUPABASE_RPC_ERROR] ${name}: ${String(err)}`);
		}
		throw err;
	}
}

module.exports = { supabase, callRpc };

// Optional DRY_RUN helpers for basic CRUD
const db = {
	insert: async (table, values) => {
		if (config.dryRun) {
			logger.warn(`[DRY_RUN] DB.insert(${table}) skipped`);
			return { error: null, data: values };
		}
		return supabase.from(table).insert(values);
	},
	update: async (table, values, match) => {
		if (config.dryRun) {
			logger.warn(`[DRY_RUN] DB.update(${table}) skipped`);
			return { error: null, data: values };
		}
		return supabase.from(table).update(values).match(match);
	},
};

module.exports.db = db;
