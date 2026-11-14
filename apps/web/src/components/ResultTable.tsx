import type { MessageTable } from '../lib/message-blocks';

/**
 * Таблица из ответа агента или из разобранного документа.
 *
 * Горизонтальный скролл вместо переноса: широкие выгрузки (начисления,
 * позиции резюме) остаются читаемыми на телефоне.
 */
export function ResultTable({
  table,
  label,
  caption,
}: {
  table: MessageTable;
  /** Доступное название таблицы для скринридера. */
  label: string;
  /** Видимый заголовок, если он есть у таблицы. */
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-outline-variant bg-surface-container/60">
      <table className="min-w-full border-collapse text-left text-xs">
        <caption
          className={
            caption === undefined
              ? 'sr-only'
              : 'px-3 pt-2 text-left text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant'
          }
        >
          {caption ?? label}
        </caption>
        <thead className="bg-surface-container-high text-on-surface">
          <tr>
            {table.columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                scope="col"
                className="whitespace-nowrap border-b border-outline-variant px-3 py-2 font-semibold"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-outline-variant/60 last:border-b-0"
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="px-3 py-2 align-top text-on-surface"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
