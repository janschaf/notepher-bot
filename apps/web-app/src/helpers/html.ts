export function stripTags(content: string | null | undefined) {
  return (content ?? '').replace(/(<([^>]+)>)/gi, ' ') || ''
}
