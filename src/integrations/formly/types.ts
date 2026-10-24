export type FormlyQuestionType =
  | 'RATING_STARS'
  | 'NPS'
  | 'NPS_SCALE'
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'DROPDOWN'
  | 'SHORT_ANSWER'
  | 'FREE_TEXT'
  | 'PARAGRAPH'
  | 'NUMBER'
  | 'DATE'
  | 'TIME'
  | 'BOOLEAN_YES_NO'
  | 'DICHOTOMOUS'
  | 'LINEAR_SCALE'
  | 'LIKERT';

export interface FormlyOption {
  label: string;
  value: string;
}

export interface FormlyQuestionConfig {
  minValue?: number;
  maxValue?: number;
  lowLabel?: string;
  highLabel?: string;
  placeholder?: string;
  [key: string]: unknown;
}

export interface FormlyQuestionInput {
  id?: string;
  title: string;
  type: FormlyQuestionType;
  required?: boolean;
  options?: FormlyOption[];
  config?: FormlyQuestionConfig;
}

export interface FormlySurveySettings {
  themePrimaryColor?: string;
  themeBackgroundColor?: string;
  allowAnonymous?: boolean;
  [key: string]: unknown;
}

export interface CreateSurveyPayload {
  title: string;
  description?: string;
  publishImmediately?: boolean;
  settings?: FormlySurveySettings;
  questions: FormlyQuestionInput[];
}

export interface CreateSurveyResponse {
  surveyId: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  totalQuestions?: number;
  questionCount?: number;
  publicUrl: string;
  shareUrl?: string;
  builderUrl?: string;
  resultsUrl?: string;
  createdAt: string;
}

export interface IntegrationRequestPayload {
  companyName: string;
  applicantName: string;
  applicantEmail: string;
  systemType: string;
  intendedUse: string;
  webhookUrl?: string;
}

export interface IntegrationRequestResponse {
  id: string;
  companyName: string;
  applicantName: string;
  applicantEmail: string;
  systemType: string;
  intendedUse: string;
  webhookUrl: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  tenantId: string;
  apiKey: string | null;
  adminNotes: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface SubmitAnswerInput {
  questionId: string;
  value?: string | number | boolean;
  selectedOptions?: string[];
  text?: string;
}

export interface SubmitResponsePayload {
  answers: SubmitAnswerInput[];
  metadata?: Record<string, unknown>;
}

export interface SubmitResponseResult {
  responseId: string;
  surveyId: string;
  submittedAt: string;
  message?: string;
}

export interface FormlyAnswerRecord {
  questionId?: string;
  questionTitle?: string;
  questionType?: FormlyQuestionType;
  value?: string | number | boolean;
  selectedOptions?: string[];
  text?: string;
}

export interface FormlySurveyResponseItem {
  responseId: string;
  submittedAt: string;
  metadata?: Record<string, unknown>;
  answers: FormlyAnswerRecord[];
}

export interface SurveyAnalyticsResponse {
  surveyId: string;
  totalResponses: number;
  npsScore?: number | null;
  averageRating?: number | null;
  responses: FormlySurveyResponseItem[];
}

export type FormlyWebhookEventType =
  | 'RESPONSE_COMPLETED'
  | 'SURVEY_PUBLISHED'
  | 'SURVEY_CREATED';

export interface FormlyWebhookPayload {
  eventId: string;
  eventType: FormlyWebhookEventType;
  timestamp: string;
  tenantId?: string;
  data: {
    surveyId: string;
    surveyTitle?: string;
    responseId?: string;
    submittedAt?: string;
    answers?: FormlyAnswerRecord[];
    [key: string]: unknown;
  };
}
