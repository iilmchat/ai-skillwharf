import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ToolDescriptor } from '../contracts.js';
import { jsonSchemaToZod } from './tool-schema.js';

/**
 * Строит LangChain-инструменты-заглушки из описаний API.
 *
 * Модель видит только name/description/JSON Schema — этого достаточно для
 * function calling. Само выполнение идёт батчем через `tools`-узел графа и
 * внутренний API; локальный `func` намеренно недоступен.
 */
export function createRemoteTools(
  descriptors: readonly ToolDescriptor[],
): StructuredToolInterface[] {
  return descriptors.map(
    (descriptor) =>
      new DynamicStructuredTool({
        name: descriptor.name,
        description: descriptor.description,
        schema: jsonSchemaToZod(descriptor.parameters),
        func: async (): Promise<string> => {
          throw new Error(
            `Инструмент ${descriptor.name} выполняется через API, а не локально`,
          );
        },
      }),
  );
}
