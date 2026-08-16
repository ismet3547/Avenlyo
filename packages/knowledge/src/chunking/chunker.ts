export interface KnowledgeChunkDraft {
  readonly chunkIndex: number;
  readonly content: string;
}

export interface ChunkingOptions {
  readonly maxCharacters?: number;
  readonly overlapCharacters?: number;
}

const defaultMaxCharacters = 2_500;
const defaultOverlapCharacters = 250;

function normalizeParagraphs(content: string): readonly string[] {
  return content
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

function overlapTail(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const slice = value.slice(-maximum);
  const boundary = slice.indexOf(' ');
  return boundary >= 0 ? slice.slice(boundary + 1) : slice;
}

/** Stable, heading-aware text chunking without an LLM. */
export function chunkKnowledgeContent(
  content: string,
  options: ChunkingOptions = {},
): readonly KnowledgeChunkDraft[] {
  const maxCharacters = options.maxCharacters ?? defaultMaxCharacters;
  const overlapCharacters = options.overlapCharacters ?? defaultOverlapCharacters;
  if (maxCharacters < 100 || overlapCharacters < 0 || overlapCharacters >= maxCharacters) {
    throw new Error('Invalid knowledge chunking configuration.');
  }

  const paragraphs = normalizeParagraphs(content);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const normalized = current.trim();
    if (normalized) chunks.push(normalized);
  };

  for (const paragraph of paragraphs) {
    const separator = current ? '\n\n' : '';
    if (current && current.length + separator.length + paragraph.length > maxCharacters) {
      pushCurrent();
      current = overlapTail(current, overlapCharacters);
    }

    if (paragraph.length > maxCharacters) {
      const words = paragraph.split(' ');
      for (const word of words) {
        if (current && current.length + word.length + 1 > maxCharacters) {
          pushCurrent();
          current = overlapTail(current, overlapCharacters);
        }
        current = current ? `${current} ${word}` : word;
      }
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  pushCurrent();

  return chunks
    .filter((chunk) => chunk.length >= 40)
    .map((chunk, chunkIndex) => ({ chunkIndex, content: chunk }));
}
