/**
 * Accepting a collaboration invitation.
 *
 * A port because the endpoint that serves it does not live in this module's router.
 * The caller holds only a token and has no website reference yet, so it cannot pass
 * the per-website access guard those routes apply — it is mounted on the `/user`
 * branch instead, which used to reach into the member implementation directly to get at
 * this one function.
 */
export interface WebsiteInvitations {
  /**
   * Accept an invitation and return the website it grants access to.
   *
   * Throws with a `status` for every rejection — unknown token, already accepted,
   * expired, or signed in as the wrong account — because the HTTP layer maps those to
   * distinct codes and the caller needs to tell them apart.
   */
  acceptByToken(userId: string, token: string): Promise<{ data: { websiteId: string } }>;
}
