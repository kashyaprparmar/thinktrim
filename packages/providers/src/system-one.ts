/** The documented common question/answer wire shape, not a core decision contract. */
export interface SystemOneJsonObject {
  readonly [key: string]: SystemOneJsonValue;
}

export type SystemOneJsonValue =
  string | number | boolean | null | readonly SystemOneJsonValue[] | SystemOneJsonObject;

export type SystemOneState = string | SystemOneJsonObject | readonly SystemOneJsonValue[];

export interface SystemOneNoulQuestion {
  readonly type: "noul";
  readonly instructions?: SystemOneJsonValue;
  readonly criteria?: {
    readonly true?: SystemOneJsonValue;
    readonly false?: SystemOneJsonValue;
  } | null;
}

export interface SystemOneChoiceQuestion {
  readonly type: "choice";
  readonly instructions?: SystemOneJsonValue;
  readonly criteria: Readonly<Record<string, SystemOneJsonValue>>;
}

export interface SystemOneScoreQuestion {
  readonly type: "score";
  readonly instructions?: SystemOneJsonValue;
  readonly criteria: readonly SystemOneJsonValue[];
}

export type SystemOneQuestion =
  SystemOneNoulQuestion | SystemOneChoiceQuestion | SystemOneScoreQuestion;

export interface SystemOneRequest {
  readonly state: SystemOneState;
  readonly model?: string;
  readonly questions: Readonly<Record<string, SystemOneQuestion>>;
}

export interface SystemOneNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface SystemOneChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface SystemOneScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly legend: Readonly<Record<string, SystemOneJsonValue>>;
  readonly probabilities: Readonly<Record<string, number>>;
}

export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer;

export interface SystemOneUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost?: number;
}

export interface SystemOneResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, SystemOneAnswer>>;
  readonly usage: SystemOneUsage;
  readonly id?: string;
  readonly provider?: string;
}
