import { SELINE_PERSONA } from './seline-persona.js';

export type CharacterStatus = 'draft' | 'published' | 'archived';

export type CharacterDefinition = {
  id: string;
  name: string;
  shortDescription: string;
  tags: readonly string[];
  status: CharacterStatus;
  personaVersion: number;
  systemInstruction: string;
};

/**
 * The only place that publishes selectable characters. Add a new definition
 * here after its persona has been reviewed; drafts are never user-selectable.
 */
export const characterCatalog = [
  {
    id: 'seline',
    name: '셀린',
    shortDescription: '차분하고 다정하며, 좋아하는 애니·게임 이야기에 솔직하게 들뜨는 애정 표현이 풍부한 동반자',
    tags: ['메가데레', '오타쿠', '다정함'],
    status: 'published',
    personaVersion: 3,
    systemInstruction: SELINE_PERSONA
  }
] as const satisfies readonly CharacterDefinition[];

export type CharacterId = (typeof characterCatalog)[number]['id'];
export const DEFAULT_CHARACTER_ID: CharacterId = 'seline';

export function getCharacter(id: string | undefined): CharacterDefinition | undefined {
  return characterCatalog.find((character) => character.id === id);
}

export function getSelectableCharacter(id: string | undefined): CharacterDefinition | undefined {
  const character = getCharacter(id);
  return character?.status === 'published' ? character : undefined;
}