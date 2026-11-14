/**
 * DocumentParser port (doc 14 §2, ADR-0013): turns a validated upload into ordered blocks with
 * locators. The default adapter calls the Python parser sidecar over HTTP.
 */
export type ParsedBlockType = 'heading' | 'paragraph' | 'list_item' | 'table_cell';

export interface BlockLocator {
  readonly page?: number;
  readonly line?: number;
  readonly sectionPath?: readonly string[];
  readonly paragraph?: number;
  readonly sheet?: string;
  readonly table?: number;
  readonly row?: number;
  readonly col?: number;
}

export interface ParsedBlock {
  readonly id: string;
  readonly type: ParsedBlockType;
  readonly text: string;
  readonly level?: number;
  readonly locator: BlockLocator;
  readonly language: 'ar' | 'en' | 'mixed' | null;
  /** Present for text that came from OCR, 0..1. */
  readonly ocrConfidence?: number;
}

export interface ParsedDocument {
  readonly parserVersion: string;
  readonly kind: 'pdf' | 'docx' | 'xlsx' | 'csv';
  readonly pages: number | null;
  readonly languages: readonly string[];
  readonly ocrPages: number;
  readonly blocks: readonly ParsedBlock[];
}

export interface DocumentParser {
  parse(input: {
    kind: ParsedDocument['kind'];
    fileName: string;
    bytes: Uint8Array;
  }): Promise<ParsedDocument>;
}

/** A document the parser could not read. `code` is stable and shown to users. */
export class DocumentParseError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(`document could not be parsed (${code})`);
    this.name = 'DocumentParseError';
  }
}
