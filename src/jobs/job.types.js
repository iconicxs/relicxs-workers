/**
 * Central job types and payload shapes.
 */

/**
 * @typedef {Object} AiAnalysisJob
 * @property {string} tenant_id
 * @property {string} asset_id
 * @property {string} ai_description_id
 * @property {string} [batch_id]
 * @property {('individual'|'standard'|'batch')} processing_type
 */

/**
 * @typedef {Object} ImageProcessingJob
 * @property {string} tenant_id
 * @property {string} asset_id
 * @property {string} source_bucket
 * @property {string} target_bucket
 * @property {string} [source_path]
 * @property {string} [target_path]
 * @property {('individual'|'standard'|'batch')} processing_type
 */

const JOB_TYPES = {
	AI_ANALYSIS: 'ai_analysis',
	IMAGE_PROCESSING: 'image_processing',
};

module.exports = { JOB_TYPES };
