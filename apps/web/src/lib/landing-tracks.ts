/**
 * Данные треков лендинга.
 *
 * Витрина карточек (буква, иконка) и модальное окно «Подробнее» (агенты, шаги,
 * тарифы) читают один и тот же список, поэтому он вынесен из страницы.
 * Тексты живут в локалях: `landing.tracks.items.<id>.*`.
 */
export type TrackId =
  | 'pvz'
  | 'dev'
  | 'ecommerce'
  | 'marketing'
  | 'education'
  | 'content'
  | 'hr'
  | 'documents'
  | 'ocr'
  | 'finance'
  | 'wholesale'
  | 'production';

export type TrackPricingKey =
  'free' | 'pro' | 'team' | 'enterprise' | 'payPerCall' | 'payPerOutcome';

export interface TrackPricing {
  /** Название тарифа — термин продукта, одинаковый в ru и en. */
  plan: string;
  /** Ключ описания: `landing.tracks.items.<id>.pricing.<key>`. */
  key: TrackPricingKey;
}

export interface LandingTrack {
  id: TrackId;
  letter: string;
  icon: string;
  /** Ключи агентов: `landing.tracks.items.<id>.agents.<key>`. */
  agentKeys: readonly string[];
  /** Ключи шагов: `landing.tracks.items.<id>.steps.<key>`. */
  stepKeys: readonly string[];
  pricing: readonly TrackPricing[];
}

export const LANDING_TRACKS: readonly LandingTrack[] = [
  {
    id: 'pvz',
    letter: 'A',
    icon: '📦',
    agentKeys: ['storekeeper', 'operator', 'returns', 'reporting', 'support'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Outcome', key: 'payPerOutcome' },
    ],
  },
  {
    id: 'dev',
    letter: 'B',
    icon: '🛠️',
    agentKeys: ['reviewer', 'oncall', 'tester', 'documenter', 'security'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Team', key: 'team' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'ecommerce',
    letter: 'C',
    icon: '🛒',
    agentKeys: ['dispatcher', 'support', 'catalog', 'ads', 'analyst'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'marketing',
    letter: 'D',
    icon: '🎨',
    agentKeys: ['dispatcher', 'copywriter', 'design', 'seo', 'account'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'education',
    letter: 'E',
    icon: '🎓',
    agentKeys: ['tutor', 'methodist', 'checker', 'content', 'dispatcher'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'content',
    letter: 'F',
    icon: '📝',
    agentKeys: ['trend', 'copywriter', 'factchecker', 'editor'],
    stepKeys: ['s1', 's2', 's3', 's4', 's5'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Outcome', key: 'payPerOutcome' },
    ],
  },
  {
    id: 'hr',
    letter: 'G',
    icon: '👥',
    agentKeys: ['screener', 'interviewer', 'coordinator', 'recruiter'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Outcome', key: 'payPerOutcome' },
    ],
  },
  {
    id: 'documents',
    letter: 'H',
    icon: '📄',
    agentKeys: ['secretary', 'lawyer', 'finance', 'director'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Enterprise', key: 'enterprise' },
      { plan: 'Pay-per-Outcome', key: 'payPerOutcome' },
    ],
  },
  {
    id: 'ocr',
    letter: 'I',
    icon: '🔍',
    agentKeys: ['pdf', 'ocr', 'docx', 'analyzer'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Enterprise', key: 'enterprise' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'finance',
    letter: 'J',
    icon: '📊',
    agentKeys: ['unit', 'leak', 'price', 'fraud'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'wholesale',
    letter: 'K',
    icon: '🏬',
    agentKeys: ['sales', 'operations', 'credit', 'margin'],
    stepKeys: ['s1', 's2', 's3', 's4'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Team', key: 'team' },
      { plan: 'Pay-per-Call', key: 'payPerCall' },
    ],
  },
  {
    id: 'production',
    letter: 'L',
    icon: '🏭',
    agentKeys: ['configurator', 'procurement', 'technologist', 'quality'],
    stepKeys: ['s1', 's2', 's3', 's4', 's5'],
    pricing: [
      { plan: 'Free', key: 'free' },
      { plan: 'Pro', key: 'pro' },
      { plan: 'Pay-per-Outcome', key: 'payPerOutcome' },
    ],
  },
];

/** Состояние модального окна: id открытого трека или `null`. */
export function findLandingTrack(trackId: TrackId): LandingTrack | undefined {
  return LANDING_TRACKS.find((track) => track.id === trackId);
}
