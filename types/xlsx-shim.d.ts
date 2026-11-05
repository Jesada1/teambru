declare module "xlsx" {
  export type WorkBook = {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  };

  export type WorkSheet = Record<string, unknown>;

  export function read(
    data: ArrayBuffer,
    opts?: { type?: string }
  ): WorkBook;

  export function writeFile(
    workbook: WorkBook,
    filename: string,
    opts?: Record<string, unknown>
  ): void;

  export const utils: {
    book_new(): WorkBook;
    book_append_sheet(
      workbook: WorkBook,
      worksheet: WorkSheet,
      name: string
    ): void;
    aoa_to_sheet(data: unknown[][]): WorkSheet;
    json_to_sheet(data: Record<string, unknown>[]): WorkSheet;
    sheet_to_json<T = unknown>(
      sheet: unknown,
      opts?: {
        header?: number | string[];
        defval?: unknown;
        raw?: boolean;
      }
    ): T[];
  };
}
