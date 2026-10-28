import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesAnyProcess, normalizeProcess } from '../../packages/cortico-world-gaming-alont1/src/proc.ts'

test('Windows process normalization accepts paired quotes, inner whitespace, case and suffix', () => {
  for(const [input,expected] of [
    [' SearchHost.EXE ','searchhost'], ['"Endfield.exe"','endfield'], ['StarRail','starrail'],
    [" ' Endfield.ExE ' ",'endfield'], ['"\' StarRail.EXE \'"','starrail'],
    ['  ',''], ['""',''], ['a.exe-helper','a.exe-helper'],
  ]) assert.equal(normalizeProcess(input),expected)
  assert.equal(normalizeProcess(undefined),'')
  assert.equal(normalizeProcess(null),'')
})

test('process membership is exact after normalization and never matches an empty entry', () => {
  const processes=['StarRail',' " Endfield.exe " ','']
  for(const name of ['STARRAIL','endfield.EXE'," 'StarRail.exe' "]) assert.equal(matchesAnyProcess(processes,name),true)
  for(const name of ['SearchHost','','  ','endfield-launcher','xStarRail']) assert.equal(matchesAnyProcess(processes,name),false)
  assert.equal(matchesAnyProcess([], 'StarRail'),false)
})
