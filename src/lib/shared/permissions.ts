export const ROLES = {
  PLATFORM_OWNER: "PLATFORM_OWNER",
  CURATOR: "CURATOR",
  SUBSCRIBER: "SUBSCRIBER",
  GUEST: "GUEST"
} as const;

export type Role = keyof typeof ROLES;

export const PERMISSIONS = {
  // Global Administration
  PLATFORM_MANAGE: "platform:manage",
  
  // Curator/Editor Actions
  DECK_MANAGE: "deck:manage",
  CARD_CURATE: "card:curate",
  AUDIO_GENERATION: "audio:generation",
  
  // Learner/Subscriber Actions
  STUDY_SESSION_START: "study:session_start",
  SRS_UPDATE: "srs:update",
  SKINS_TOGGLE: "skins:toggle",
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  PLATFORM_OWNER: [
    PERMISSIONS.PLATFORM_MANAGE,
    PERMISSIONS.DECK_MANAGE,
    PERMISSIONS.CARD_CURATE,
    PERMISSIONS.AUDIO_GENERATION,
    PERMISSIONS.STUDY_SESSION_START,
    PERMISSIONS.SRS_UPDATE,
    PERMISSIONS.SKINS_TOGGLE
  ],

  CURATOR: [
    PERMISSIONS.DECK_MANAGE,
    PERMISSIONS.CARD_CURATE,
    PERMISSIONS.AUDIO_GENERATION,
    PERMISSIONS.STUDY_SESSION_START,
    PERMISSIONS.SRS_UPDATE,
    PERMISSIONS.SKINS_TOGGLE
  ],

  SUBSCRIBER: [
    PERMISSIONS.STUDY_SESSION_START,
    PERMISSIONS.SRS_UPDATE,
    PERMISSIONS.SKINS_TOGGLE
  ],

  GUEST: [
    PERMISSIONS.STUDY_SESSION_START,
    PERMISSIONS.SRS_UPDATE
  ]
};

export const hasPermission = (role: string | null | undefined, permission: Permission): boolean => {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role as Role];
  return perms ? perms.includes(permission) : false;
};
