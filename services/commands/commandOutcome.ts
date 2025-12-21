import { TranslationParams } from '../../i18n/types';

export type CommandResult = { ok: boolean; error?: string | undefined };

export type CommandFeedback = {
  type: 'error';
  message: string;
};

export interface CommandOutcome {
  shouldClosePicker: boolean;
  feedback?: CommandFeedback;
}

type Translator = (key: string, params?: TranslationParams & { defaultValue?: string }) => string;

export const interpretCommandResult = (
  result: CommandResult,
  translate: Translator
): CommandOutcome => {
  if (result.ok) {
    return { shouldClosePicker: true };
  }

  const message = translate('msg.commandFailed', {
    error: result.error ?? translate('msg.unknownError', { defaultValue: 'Unknown error' })
  });

  return {
    shouldClosePicker: false,
    feedback: {
      type: 'error',
      message
    }
  };
};
