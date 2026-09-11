import { Router } from 'express'
import pool from '../db/index.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import {
  signup,
  login,
  me,
  forgotPassword,
  resetPassword,
} from '../controllers/authController.js'
import { socialLogin } from '../controllers/socialController.js'
import {
  createProperty,
  getProperty,
  listProperties,
  listOwnerProperties,
  updateProperty,
  applyToProperty,
  scheduleViewing,
} from '../controllers/propertyController.js'
import {
  toggleFavorite,
  listFavorites,
  compareProperties,
  togglePriceAlert,
  listPriceAlerts,
  createInquiry,
  listMyInquiries,
  listOwnerInquiries,
} from '../controllers/tenantController.js'
import {
  overview,
  drilldown,
  listUsers,
  updateUserStatus,
  updateUserRole,
  listAdminProperties,
  updatePropertyStatus,
  deleteProperty,
  listPayments,
  updatePaymentStatus,
} from '../controllers/adminController.js'
import {
  getRevenueSettings,
  updateRevenueRule,
  previewQuote,
  listRevenueTransactions,
  createRevenueTransaction,
} from '../controllers/revenueAdminController.js'
import {
  createLease,
  listLeases,
  listRentPayments,
  generateNextRent,
  runRentSweep,
  payRent,
  requestPayout,
  listPayouts,
  updatePayoutStatus,
  listLedger,
  listInvoices,
  createDispute,
  listDisputes,
  updateDispute,
  listNotifications,
  markNotificationsRead,
  listAgents,
  updateAgentVerification,
  getPlatformSettings,
  updatePlatformSettings,
  listTiers,
  upsertTier,
  deleteTier,
  listAuditLogs,
  quoteWithTiers,
} from '../controllers/financeController.js'
import { paymentWebhook, verifyPayment } from '../controllers/webhookController.js'
import {
  createContactMessage,
  listLeads,
  getLead,
  updateLead,
  listOutbox,
} from '../controllers/leadController.js'
import {
  postChatMessage,
  getChatThread,
  listChatThreads,
  getAdminChatThread,
  replyToChatThread,
  chatUnreadCount,
} from '../controllers/chatController.js'
import {
  listBlogPosts,
  getBlogPost,
  adminListPosts,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} from '../controllers/blogController.js'
import { getProvider, newReference, recordPendingPayment } from '../services/payments.js'
import { validate } from '../validation/validate.js'
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  socialLoginSchema,
  propertyCreateSchema,
  applySchema,
  scheduleSchema,
  contactMessageSchema,
} from '../validation/schemas.js'

const router = Router()

router.post('/auth/signup', validate(signupSchema), signup)
router.post('/auth/login', validate(loginSchema), login)
router.post('/auth/forgot-password', validate(forgotPasswordSchema), forgotPassword)
router.post('/auth/reset-password', validate(resetPasswordSchema), resetPassword)
router.post('/auth/social', validate(socialLoginSchema), socialLogin)
router.get('/auth/me', requireAuth(), me)

// Properties — landlords AND agents can list (requireAuth accepts one role
// or a list). New listings start pending until an admin approves them.
router.post('/properties', requireAuth(['owner', 'agent']), validate(propertyCreateSchema), createProperty)
router.get('/properties', listProperties)
router.get('/properties/:propertyId', optionalAuth, getProperty)

// Tenant apply / schedule — POSTing the same endpoint again undoes it
// (toggle), so the UI can label the button Apply Now <-> Undo.
router.post('/properties/:propertyId/apply', requireAuth('seeker'), validate(applySchema), applyToProperty)
router.post('/properties/:propertyId/schedule', requireAuth('seeker'), validate(scheduleSchema), scheduleViewing)

// Owner edits (price changes trigger tenant price alerts).
router.patch('/properties/:propertyId', requireAuth(), updateProperty)

// Tenant integrations: favorites, compare, alerts, inquiries.
router.post('/properties/:propertyId/favorite', requireAuth(), toggleFavorite)
router.get('/favorites', requireAuth(), listFavorites)
router.post('/properties/compare', requireAuth(), compareProperties)
router.post('/properties/:propertyId/alert', requireAuth(), togglePriceAlert)
router.get('/price-alerts', requireAuth(), listPriceAlerts)
router.post('/properties/:propertyId/inquire', requireAuth(), createInquiry)
router.get('/my/inquiries', requireAuth(), listMyInquiries)
router.get('/owner/inquiries', requireAuth(), listOwnerInquiries)
router.get('/owner/properties', requireAuth(['owner', 'agent']), listOwnerProperties)

// Admin control center — every route requires an admin account.
router.get('/admin/overview', requireAuth('admin'), overview)
router.get('/admin/drilldown/:key', requireAuth('admin'), drilldown)
router.get('/admin/users', requireAuth('admin'), listUsers)
router.patch('/admin/users/:userId/status', requireAuth('admin'), updateUserStatus)
router.patch('/admin/users/:userId/role', requireAuth('admin'), updateUserRole)
router.get('/admin/properties', requireAuth('admin'), listAdminProperties)
router.patch('/admin/properties/:propertyId/status', requireAuth('admin'), updatePropertyStatus)
router.delete('/admin/properties/:propertyId', requireAuth('admin'), deleteProperty)
router.get('/admin/payments', requireAuth('admin'), listPayments)
router.patch('/admin/payments/:paymentId/status', requireAuth('admin'), updatePaymentStatus)

// Revenue & Commission settings + transparent transaction ledger.
router.get('/admin/revenue/settings', requireAuth('admin'), getRevenueSettings)
router.patch('/admin/revenue/rules/:ruleId', requireAuth('admin'), updateRevenueRule)
router.post('/admin/revenue/quote', requireAuth('admin'), previewQuote)
router.get('/admin/revenue/transactions', requireAuth('admin'), listRevenueTransactions)
router.post('/admin/revenue/transactions', requireAuth('admin'), createRevenueTransaction)

// ---- Payments: provider-abstracted initiation + webhook trust boundary ----
// Webhook has NO auth middleware (providers can't hold a JWT); it verifies
// itself via the raw-body HMAC signature. Must be registered before the
// generic json handling already applied globally in server.js — rawBody is
// captured there.
router.post('/payments/webhook', paymentWebhook)

// Buyer initiates a property purchase (sale:propertyId purpose). Creates a
// pending payment and returns the provider authorization URL (or mock
// reference in dev). Settlement happens ONLY via webhook/verification.
router.post('/properties/:propertyId/purchase', requireAuth(), async (req, res) => {
  const { propertyId } = req.params
  try {
    const [rows] = await pool.query("SELECT * FROM properties WHERE id = ? AND status = 'active' AND purpose = 'sale'", [propertyId])
    const property = rows[0]
    if (!property) return res.status(404).json({ error: 'Property not found or not for sale' })
    if (property.owner_id === req.user.id) return res.status(403).json({ error: 'You cannot buy your own listing' })

    const amount = Number(property.sale_amount || 0)
    if (!(amount > 0)) return res.status(409).json({ error: 'Property has no sale price configured' })

    const reference = newReference('BUY')
    await recordPendingPayment({
      userId: req.user.id,
      propertyId: property.id,
      kind: 'commission_sale',
      amount,
      reference,
      provider: getProvider().name,
      purpose: `sale:${property.id}`,
      meta: { price: amount, agentId: property.agent_id ?? null },
    })
    const provider = getProvider()
    const result = await provider.initiate({
      amount,
      reference,
      email: req.user.email,
      meta: { propertyId: property.id },
    })
    return res.status(201).json(result)
  } catch (error) {
    console.error('purchase initiation failed:', error)
    return res.status(500).json({ error: 'Could not initiate the purchase' })
  }
})

// Client-side verification fallback (server re-verifies with the provider).
router.get('/payments/verify/:reference', requireAuth(), verifyPayment)

// ---- Rent collection (leases, charges, autopay hooks) ----
router.get('/leases', requireAuth('admin'), listLeases)
router.post('/leases', requireAuth('admin'), createLease)
router.get('/rent-payments', requireAuth('admin'), listRentPayments)
router.post('/leases/:leaseId/generate-rent', requireAuth('admin'), generateNextRent)
router.post('/admin/rent-sweep', requireAuth('admin'), runRentSweep)
router.post('/rent-payments/:rentPaymentId/pay', requireAuth(), payRent)

// ---- Payouts: users request, admins approve/release ----
router.post('/payouts', requireAuth(), requestPayout)
router.get('/admin/payouts', requireAuth('admin'), listPayouts)
router.patch('/admin/payouts/:payoutId/status', requireAuth('admin'), updatePayoutStatus)

// ---- Ledger, invoices, disputes, notifications ----
router.get('/admin/ledger', requireAuth('admin'), listLedger)
router.get('/invoices', requireAuth('admin'), listInvoices)
router.post('/disputes', requireAuth(), createDispute)
router.get('/admin/disputes', requireAuth('admin'), listDisputes)
router.patch('/admin/disputes/:disputeId', requireAuth('admin'), updateDispute)
router.get('/notifications', requireAuth(), listNotifications)
router.post('/notifications/read', requireAuth(), markNotificationsRead)

// ---- Agents, settings, tiers, audit log ----
router.get('/admin/agents', requireAuth('admin'), listAgents)
router.patch('/admin/agents/:userId/verification', requireAuth('admin'), updateAgentVerification)
router.get('/admin/settings', requireAuth('admin'), getPlatformSettings)
router.patch('/admin/settings', requireAuth('admin'), updatePlatformSettings)
router.get('/admin/commission-tiers', requireAuth('admin'), listTiers)
router.post('/admin/commission-tiers', requireAuth('admin'), upsertTier)
router.delete('/admin/commission-tiers/:tierId', requireAuth('admin'), deleteTier)
router.get('/admin/audit-logs', requireAuth('admin'), listAuditLogs)
router.post('/admin/revenue/quote-tiers', requireAuth('admin'), quoteWithTiers)

// ---- Leads: contact-form capture + admin CRM (New -> Contacted -> Closed) ----
router.post('/contact', validate(contactMessageSchema), createContactMessage)
router.get('/admin/leads', requireAuth('admin'), listLeads)
router.get('/admin/leads/:leadId', requireAuth('admin'), getLead)
router.patch('/admin/leads/:leadId', requireAuth('admin'), updateLead)
router.get('/admin/outbox', requireAuth('admin'), listOutbox)

// ---- Live chat: visitor widget + admin agent inbox ----
router.post('/chat', optionalAuth, postChatMessage)
router.get('/chat/:threadKey', optionalAuth, getChatThread)
router.get('/admin/chat/threads', requireAuth('admin'), listChatThreads)
router.get('/admin/chat/threads/:threadKey', requireAuth('admin'), getAdminChatThread)
router.post('/admin/chat/threads/:threadKey/reply', requireAuth('admin'), replyToChatThread)
router.get('/admin/chat/unread', requireAuth('admin'), chatUnreadCount)

// ---- Blog: public reader + admin publishing ----
router.get('/blog', listBlogPosts)
router.get('/blog/:slug', getBlogPost)
router.get('/admin/blog', requireAuth('admin'), adminListPosts)
router.post('/admin/blog', requireAuth('admin'), createBlogPost)
router.patch('/admin/blog/:postId', requireAuth('admin'), updateBlogPost)
router.delete('/admin/blog/:postId', requireAuth('admin'), deleteBlogPost)

export default router
