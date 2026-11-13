import { z } from 'zod';

/**
 * Преобразует JSON Schema аргументов инструмента (её строит API через
 * `z.toJSONSchema`) в Zod-схему для LangChain. Поддерживается подмножество,
 * которое используют манифесты навыков: объекты, строки, числа, булевы
 * значения, массивы, enum и вложенные структуры. Неизвестная конструкция
 * превращается в `z.unknown()`, а не роняет запуск графа.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.unknown();
  }

  const record = schema as Record<string, unknown>;
  const description =
    typeof record.description === 'string' ? record.description : undefined;
  const converted = convertType(record);

  return description === undefined ? converted : converted.describe(description);
}

function convertType(record: Record<string, unknown>): z.ZodTypeAny {
  const enumValues = record.enum;

  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const strings = enumValues.filter(
      (value): value is string => typeof value === 'string',
    );

    if (strings.length === enumValues.length) {
      return z.enum(strings as [string, ...string[]]);
    }
  }

  const constValue = record.const;

  if (typeof constValue === 'string') {
    return z.literal(constValue);
  }

  const variants = record.anyOf ?? record.oneOf;

  if (Array.isArray(variants) && variants.length > 0) {
    const options = variants.map((variant) => jsonSchemaToZod(variant));

    if (options.length === 1) {
      return options[0]!;
    }

    return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  const type = record.type;

  if (Array.isArray(type)) {
    return z.unknown();
  }

  switch (type) {
    case 'string':
      return z.string();
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(jsonSchemaToZod(record.items));
    case 'object':
      return objectSchema(record);
    default:
      return record.properties === undefined
        ? z.unknown()
        : objectSchema(record);
  }
}

function objectSchema(record: Record<string, unknown>): z.ZodTypeAny {
  const properties = record.properties;

  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return z.record(z.string(), z.unknown());
  }

  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = jsonSchemaToZod(value);

    shape[key] = required.has(key)
      ? propertySchema
      : propertySchema.optional();
  }

  // Дополнительные поля не ломают вызов: API всё равно валидирует аргументы
  // собственными Zod-схемами и policy engine.
  return z.object(shape).passthrough();
}
