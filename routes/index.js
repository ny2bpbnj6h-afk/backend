import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  signup,
  login,
  me,
  forgotPassword,
  resetPassword,
} from '../controllers/authController.js'
import { socialLogin } from '../controllers/socialController.js'
import { validate } from '../validation/validate.js'
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  socialLoginSchema,
} from '../validation/schemas.js'

const router = Router()

router.post('/auth/signup', validate(signupSchema), signup)
router.post('/auth/login', validate(loginSchema), login)
router.post('/auth/forgot-password', validate(forgotPasswordSchema), forgotPassword)
router.post('/auth/reset-password', validate(resetPasswordSchema), resetPassword)
router.post('/auth/social', validate(socialLoginSchema), socialLogin)
router.get('/auth/me', requireAuth(), me)

export default router
