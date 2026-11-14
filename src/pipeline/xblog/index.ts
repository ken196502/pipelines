import { registerPipeline } from '../core/registry.js';
import type { PipelineDefinition } from '../core/types.js';
import { xblogConfigSchema, type XblogConfig } from './config.js';
import type { XblogDeps } from './deps.js';
import { finalizeXblog, xblogStages, type XblogState } from './stages.js';

export const xblogPipeline: PipelineDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'xblog',
  configSchema: xblogConfigSchema,
  stages: xblogStages,
  finalize: finalizeXblog,
};

registerPipeline(xblogPipeline);
