"""Bandait 3.0 — Hybrid Authentication & Multi-Band Access Control Service.

Implements Google OAuth verification, WhatsApp/SMS OTP generation/verification,
and granular role management (Owner, MusicDirector, Musician, Substitute, SoundEngineer).
"""

import time
import secrets
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

from src.domain.models import MemberRole, AuthProvider, UserProfile, UserSession, Band, BandMember


@dataclass
class OTPRecord:
    code: str
    phone: str
    channel: str  # "whatsapp" | "sms"
    created_at: float
    expires_at: float
    attempts: int = 0
    verified: bool = False


class AuthService:
    """Service handling hybrid authentication and multi-band authorization."""

    def __init__(self, otp_ttl_seconds: int = 300, session_ttl_seconds: int = 86400):
        self._otp_ttl = otp_ttl_seconds
        self._session_ttl = session_ttl_seconds
        self._otps: Dict[str, OTPRecord] = {}  # phone -> OTPRecord
        self._users: Dict[str, UserProfile] = {}  # user_id -> UserProfile
        self._users_by_phone: Dict[str, str] = {}  # phone -> user_id
        self._users_by_email: Dict[str, str] = {}  # email -> user_id
        self._bands: Dict[str, Band] = {}  # band_id -> Band
        self._band_memberships: Dict[str, List[BandMember]] = {}  # user_id -> list of BandMember
        self._sessions: Dict[str, UserSession] = {}  # token -> UserSession

    # -------------------------------------------------------------------------
    # Multi-band management
    # -------------------------------------------------------------------------
    def register_band(self, band_id: str, name: str, owner_id: str) -> Band:
        """Register a new musical band / organization."""
        band = Band(id=band_id, name=name, owner_id=owner_id, created_at=str(time.time()))
        self._bands[band_id] = band

        # Register owner as BandMember
        owner_member = BandMember(
            id=f"mem_{band_id}_{owner_id}",
            band_id=band_id,
            user_id=owner_id,
            role=MemberRole.OWNER,
        )
        self._band_memberships.setdefault(owner_id, []).append(owner_member)
        return band

    def get_band(self, band_id: str) -> Optional[Band]:
        return self._bands.get(band_id)

    def add_member_to_band(
        self,
        band_id: str,
        user_id: str,
        role: MemberRole,
        name: str = "",
        phone: str = "",
        email: str = "",
        instrument: str = "",
    ) -> BandMember:
        """Add or update member role within a specific band."""
        if band_id not in self._bands:
            raise ValueError(f"Band '{band_id}' does not exist.")

        member = BandMember(
            id=f"mem_{band_id}_{user_id}",
            band_id=band_id,
            user_id=user_id,
            name=name,
            phone=phone,
            email=email,
            role=role,
            instrument=instrument,
        )

        user_memberships = self._band_memberships.setdefault(user_id, [])
        # Replace if already in band
        self._band_memberships[user_id] = [m for m in user_memberships if m.band_id != band_id]
        self._band_memberships[user_id].append(member)
        return member

    def list_user_bands(self, user_id: str) -> List[Tuple[Band, MemberRole]]:
        """List all bands a user belongs to, with their respective roles."""
        memberships = self._band_memberships.get(user_id, [])
        results = []
        for m in memberships:
            band = self._bands.get(m.band_id)
            if band:
                results.append((band, m.role))
        return results

    # -------------------------------------------------------------------------
    # Hybrid Authentication: WhatsApp / SMS OTP
    # -------------------------------------------------------------------------
    def generate_otp(self, phone: str, channel: str = "whatsapp") -> str:
        """Generate a 6-digit OTP code for phone login (WhatsApp or SMS)."""
        clean_phone = phone.strip().replace(" ", "").replace("-", "")
        # Cryptographically secure 6-digit code
        code = f"{secrets.randbelow(900000) + 100000}"
        now = time.time()
        self._otps[clean_phone] = OTPRecord(
            code=code,
            phone=clean_phone,
            channel=channel,
            created_at=now,
            expires_at=now + self._otp_ttl,
        )
        return code

    def verify_otp(self, phone: str, code: str, user_name: str = "") -> Optional[UserSession]:
        """Verify phone OTP and create an authenticated session."""
        clean_phone = phone.strip().replace(" ", "").replace("-", "")
        record = self._otps.get(clean_phone)
        if not record:
            return None

        now = time.time()
        if now > record.expires_at:
            del self._otps[clean_phone]
            return None

        if record.attempts >= 3:
            del self._otps[clean_phone]
            return None

        record.attempts += 1

        if record.code != code:
            return None

        # Successful OTP
        record.verified = True
        del self._otps[clean_phone]

        # Get or create user
        user_id = self._users_by_phone.get(clean_phone)
        if not user_id:
            user_id = f"usr_{secrets.token_hex(6)}"
            user = UserProfile(
                id=user_id,
                name=user_name or f"User {clean_phone[-4:]}",
                phone=clean_phone,
                auth_provider=AuthProvider.OTP_WHATSAPP if record.channel == "whatsapp" else AuthProvider.OTP_SMS,
                created_at=str(now),
            )
            self._users[user_id] = user
            self._users_by_phone[clean_phone] = user_id

        return self._create_session(user_id)

    # -------------------------------------------------------------------------
    # Hybrid Authentication: Google OAuth
    # -------------------------------------------------------------------------
    def authenticate_google(
        self,
        email: str,
        name: str,
        google_sub: str,
    ) -> UserSession:
        """Authenticate via Google OAuth ID payload."""
        clean_email = email.lower().strip()
        user_id = self._users_by_email.get(clean_email)
        now = time.time()

        if not user_id:
            user_id = f"usr_g_{google_sub[:8]}"
            user = UserProfile(
                id=user_id,
                name=name,
                email=clean_email,
                auth_provider=AuthProvider.GOOGLE,
                created_at=str(now),
            )
            self._users[user_id] = user
            self._users_by_email[clean_email] = user_id

        return self._create_session(user_id)

    # -------------------------------------------------------------------------
    # Sessions & Band Switching
    # -------------------------------------------------------------------------
    def _create_session(self, user_id: str, preferred_band_id: Optional[str] = None) -> UserSession:
        user = self._users.get(user_id)
        user_name = user.name if user else "Unknown"

        # Determine active band and role
        memberships = self._band_memberships.get(user_id, [])
        active_band_id = "band_default"
        active_role = MemberRole.MUSICIAN

        if preferred_band_id:
            for m in memberships:
                if m.band_id == preferred_band_id:
                    active_band_id = m.band_id
                    active_role = m.role
                    break
        elif memberships:
            active_band_id = memberships[0].band_id
            active_role = memberships[0].role

        token = secrets.token_urlsafe(32)
        session = UserSession(
            token=token,
            user_id=user_id,
            user_name=user_name,
            active_band_id=active_band_id,
            role=active_role,
            expires_at=time.time() + self._session_ttl,
        )
        self._sessions[token] = session
        return session

    def validate_session(self, token: str) -> Optional[UserSession]:
        """Validate session token and return session if still active."""
        session = self._sessions.get(token)
        if not session:
            return None
        if time.time() > session.expires_at:
            del self._sessions[token]
            return None
        return session

    def switch_band(self, token: str, target_band_id: str) -> Optional[UserSession]:
        """Switch user active band within their valid session."""
        session = self.validate_session(token)
        if not session:
            return None

        # Check membership in target band
        memberships = self._band_memberships.get(session.user_id, [])
        target_membership = next((m for m in memberships if m.band_id == target_band_id), None)
        if not target_membership:
            return None

        updated_session = UserSession(
            token=session.token,
            user_id=session.user_id,
            user_name=session.user_name,
            active_band_id=target_band_id,
            role=target_membership.role,
            expires_at=session.expires_at,
        )
        self._sessions[token] = updated_session
        return updated_session

    # -------------------------------------------------------------------------
    # Granular Permission Evaluation
    # -------------------------------------------------------------------------
    @staticmethod
    def has_permission(role: MemberRole, action: str) -> bool:
        """Check whether a given MemberRole has permission to execute an action."""
        permissions: Dict[str, List[MemberRole]] = {
            "manage_band": [MemberRole.OWNER],
            "manage_team": [MemberRole.OWNER, MemberRole.MUSIC_DIRECTOR],
            "edit_setlist": [MemberRole.OWNER, MemberRole.MUSIC_DIRECTOR],
            "import_export_xlsx": [MemberRole.OWNER, MemberRole.MUSIC_DIRECTOR],
            "control_transport": [
                MemberRole.OWNER,
                MemberRole.MUSIC_DIRECTOR,
                MemberRole.MUSICIAN,
                MemberRole.SUBSTITUTE,
                MemberRole.SOUND_ENGINEER,
            ],
            "adjust_foh_mix": [MemberRole.OWNER, MemberRole.MUSIC_DIRECTOR, MemberRole.SOUND_ENGINEER],
            "view_lyrics": [
                MemberRole.OWNER,
                MemberRole.MUSIC_DIRECTOR,
                MemberRole.MUSICIAN,
                MemberRole.SUBSTITUTE,
                MemberRole.SOUND_ENGINEER,
            ],
        }

        allowed = permissions.get(action, [])
        return role in allowed
