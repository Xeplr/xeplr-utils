/**
 * i18n message dictionary.
 * Reusable strings keyed by a readable name.
 * CODES reference these by message key.
 *
 * Add new languages by adding a key to each entry.
 * Add new messages as needed — not limited to response codes.
 */

const MESSAGES = {
  success:                { en: 'Success',                           fr: 'Succès' },
  created:                { en: 'Created successfully',              fr: 'Créé avec succès' },
  updated:                { en: 'Updated successfully',              fr: 'Mis à jour avec succès' },
  deleted:                { en: 'Deleted successfully',              fr: 'Supprimé avec succès' },

  bad_request:            { en: 'Bad request',                       fr: 'Requête invalide' },
  unauthorized:           { en: 'Unauthorized',                      fr: 'Non autorisé' },
  access_denied:          { en: 'Access denied',                     fr: 'Accès refusé' },
  not_found:              { en: 'Not found',                         fr: 'Non trouvé' },
  already_exists:         { en: 'Already exists',                    fr: 'Existe déjà' },
  validation_failed:      { en: 'Validation failed',                 fr: 'Échec de validation' },
  too_many_requests:      { en: 'Too many requests',                 fr: 'Trop de requêtes' },

  server_error:           { en: 'Internal server error',             fr: 'Erreur interne du serveur' },
  service_unavailable:    { en: 'Service temporarily unavailable',   fr: 'Service temporairement indisponible' },

  login_success:          { en: 'Logged in successfully',            fr: 'Connexion réussie' },
  login_failed:           { en: 'Invalid email or password',         fr: 'Email ou mot de passe invalide' },
  logout_success:         { en: 'Logged out successfully',           fr: 'Déconnexion réussie' },
  account_not_active:     { en: 'Account is not activated',          fr: 'Le compte n\'est pas activé' },
  password_reset_sent:    { en: 'Password reset link sent',          fr: 'Lien de réinitialisation envoyé' },
  password_reset_success: { en: 'Password reset successfully',       fr: 'Mot de passe réinitialisé avec succès' },
  invalid_token:          { en: 'Invalid or expired token',          fr: 'Jeton invalide ou expiré' },
};

module.exports = { MESSAGES };
