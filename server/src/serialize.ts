import type { Project, SpecDocument } from './types.js'

/** A document as sent to the browser: no raw text, no dereferenced spec. */
export type WireDocument = Omit<SpecDocument, 'text' | 'openapi'> & { textLength: number }
export type WireProject = Omit<Project, 'documents'> & { documents: WireDocument[] }

/**
 * Prepares a project to cross the wire.
 *
 * Two things must never leave the server attached to a project:
 * `documents[].openapi` is a dereferenced spec whose object graph can be
 * cyclic, so JSON.stringify throws on it outright; and `documents[].text` can
 * be megabytes the UI never renders wholesale. Both are available through the
 * dedicated document route when a panel actually needs them.
 */
export function toWireProject(project: Project): WireProject {
  return {
    ...project,
    documents: project.documents.map(({ text, openapi: _openapi, ...rest }) => ({
      ...rest,
      textLength: text.length,
    })),
  }
}
