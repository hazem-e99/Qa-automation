// Public surface of the requirements module (M04).
export * from './domain.js';
export * from './requirements.js';
export * from './documents.js';
export {
  extractCandidates,
  detectColumns,
  tableHeaders,
  type Candidate,
  type ColumnMapping,
} from './extraction.js';
export {
  validateUpload,
  DEFAULT_UPLOAD_LIMITS,
  UPLOAD_KINDS,
  type UploadLimits,
} from './upload-validation.js';
export * from './changes.js';
export * from './trace.js';
export {
  exportRequirements,
  EXPORT_MAX_REQUIREMENTS,
  type ExportFile,
  type ExportFormat,
  type ExportView,
} from './export.js';
