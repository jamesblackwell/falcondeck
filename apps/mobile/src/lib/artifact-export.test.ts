import { afterEach, describe, expect, it } from 'vitest'

import {
  fileSystemEvents,
  resetFileSystemMock,
} from '@/test/__mocks__/expo-file-system'
import {
  resetSharingMock,
  setSharingAvailable,
  sharingCalls,
} from '@/test/__mocks__/expo-sharing'
import {
  artifactShareByteSize,
  assertArtifactShareSize,
  base64Payload,
  safeArtifactFilename,
  shareEmbeddedArtifact,
} from './artifact-export'

afterEach(() => {
  resetFileSystemMock()
  resetSharingMock()
})

describe('artifact export', () => {
  it('normalizes provider filenames without allowing traversal', () => {
    expect(safeArtifactFilename('../../Quarterly report?.pdf')).toBe('Quarterly-report-.pdf')
    expect(safeArtifactFilename('../..')).toBe('artifact')
  })

  it('does not forward provider-authored MIME parameters to the share sheet', async () => {
    await shareEmbeddedArtifact({
      filename: 'report.html',
      mimeType: 'text/html\r\nContent-Disposition: inline',
      text: '<p>Report</p>',
      dataUrl: null,
      byteSize: null,
    })

    expect(sharingCalls[0]?.options).toEqual({
      dialogTitle: 'Share report.html',
      mimeType: undefined,
    })
  })

  it('accepts only explicit base64 media data URLs', () => {
    expect(base64Payload('data:application/pdf;base64,aGVsbG8=')).toBe('aGVsbG8=')
    expect(base64Payload('data:text/plain,hello')).toBeNull()
    expect(base64Payload('javascript:alert(1)')).toBeNull()
  })

  it('derives UTF-8 and decoded base64 sizes instead of trusting provider metadata', () => {
    expect(artifactShareByteSize({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      text: 'café 🚀',
      dataUrl: null,
      byteSize: 1,
    })).toBe(10)
    expect(artifactShareByteSize({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      text: null,
      dataUrl: 'data:application/pdf;base64,aGVsbG8=',
      byteSize: null,
    })).toBe(5)
  })

  it('enforces the share cap when provider byte metadata is missing or understated', () => {
    expect(() => assertArtifactShareSize({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      text: 'hello',
      dataUrl: null,
      byteSize: null,
    }, 4)).toThrow('too large')
    expect(() => assertArtifactShareSize({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      text: null,
      dataUrl: 'data:application/pdf;base64,aGVsbG8=',
      byteSize: 1,
    }, 4)).toThrow('too large')
    expect(fileSystemEvents).toEqual([])
  })

  it('writes provider text to a temporary file, shares it, then cleans up', async () => {
    await shareEmbeddedArtifact({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      text: '# Notes',
      dataUrl: null,
      byteSize: null,
    })

    expect(fileSystemEvents).toEqual([
      { type: 'directory-create', value: undefined },
      { type: 'create', value: { overwrite: true } },
      { type: 'write', value: { content: '# Notes', options: undefined } },
      { type: 'directory-delete' },
    ])
  })

  it('writes provider bytes to a temporary file, shares it, then cleans up', async () => {
    await shareEmbeddedArtifact({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      text: null,
      dataUrl: 'data:application/pdf;base64,aGVsbG8=',
      byteSize: 5,
    })

    expect(fileSystemEvents).toEqual([
      { type: 'directory-create', value: undefined },
      { type: 'create', value: { overwrite: true } },
      { type: 'write', value: { content: 'aGVsbG8=', options: { encoding: 'base64' } } },
      { type: 'directory-delete' },
    ])
    expect(sharingCalls).toHaveLength(1)
    expect(sharingCalls[0]?.url).toMatch(
      /^file:\/\/\/mock-cache\/falcondeck-share-\d+-[a-z0-9]+\/report\.pdf$/,
    )
    expect(sharingCalls[0]?.options).toEqual({
      dialogTitle: 'Share report.pdf',
      mimeType: 'application/pdf',
    })
  })

  it('fails before writing when the platform share sheet is unavailable', async () => {
    setSharingAvailable(false)
    await expect(shareEmbeddedArtifact({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      text: '# Notes',
      dataUrl: null,
      byteSize: null,
    })).rejects.toThrow('Sharing is unavailable')
    expect(fileSystemEvents).toEqual([])
  })
})
