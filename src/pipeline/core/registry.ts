import { ConfigError } from '../../lib/errors.js';
import type { PipelineDefinition } from './types.js';

type AnyPipeline = PipelineDefinition<unknown, unknown, unknown>;

const registry = new Map<string, AnyPipeline>();

/** Registers a pipeline definition. Duplicate ids are a programming error. */
export function registerPipeline<C, D, S>(definition: PipelineDefinition<C, D, S>): void {
  if (registry.has(definition.id)) {
    throw new Error(`Pipeline "${definition.id}" is already registered.`);
  }
  registry.set(definition.id, definition as unknown as AnyPipeline);
}

export function getPipeline<C, D, S>(id: string): PipelineDefinition<C, D, S> {
  const definition = registry.get(id);
  if (!definition) {
    throw new ConfigError('PIPELINE_UNKNOWN', `Unknown pipeline "${id}". Known pipelines: ${listPipelineIds().join(', ') || '<none>'}.`, {
      id,
      known: listPipelineIds(),
    });
  }
  return definition as unknown as PipelineDefinition<C, D, S>;
}

export function listPipelineIds(): string[] {
  return [...registry.keys()].sort();
}
