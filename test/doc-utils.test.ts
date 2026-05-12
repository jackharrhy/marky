import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { docToText, plainTextSchema, textToDoc } from '../app/shared/doc-utils.ts'

describe('doc-utils', () => {
  it('round-trips empty content', () => {
    const doc = textToDoc('')
    assert.equal(docToText(doc), '')
  })

  it('round-trips a single line', () => {
    const doc = textToDoc('hello world')
    assert.equal(docToText(doc), 'hello world')
  })

  it('round-trips multiple lines', () => {
    const original = 'line 1\nline 2\nline 3'
    const doc = textToDoc(original)
    assert.equal(docToText(doc), original)
  })

  it('preserves blank lines', () => {
    const original = 'top\n\nbottom'
    const doc = textToDoc(original)
    assert.equal(docToText(doc), original)
  })

  it('produces a paragraph per line', () => {
    const doc = textToDoc('one\ntwo')
    let paragraphs = 0
    doc.forEach((node) => {
      if (node.type.name === 'paragraph') paragraphs++
    })
    assert.equal(paragraphs, 2)
  })

  it('uses the plain text schema', () => {
    const doc = textToDoc('x')
    assert.equal(doc.type.schema, plainTextSchema)
  })
})
