/**
 * The voice configuration action state, kept out of the `"use server"` module for the same reason
 * as the knowledge one: a server-action file may export async server functions and nothing else.
 */
export interface VoiceConfigurationActionState {
  readonly message?: string;
  readonly status: 'error' | 'idle' | 'success';
}

export const initialVoiceConfigurationActionState: VoiceConfigurationActionState = {
  status: 'idle',
};
