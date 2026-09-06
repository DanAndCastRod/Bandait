"""Tests for hybrid authentication service and multi-band access control."""

from src.domain.models import MemberRole, AuthProvider
from src.domain.auth_service import AuthService


def test_otp_flow_success():
    """Verify WhatsApp/SMS OTP generation and verification flow."""
    auth = AuthService(otp_ttl_seconds=300)
    phone = "+57 300 123 4567"
    code = auth.generate_otp(phone, channel="whatsapp")

    assert len(code) == 6
    assert code.isdigit()

    session = auth.verify_otp(phone, code, user_name="Carlos Baterista")
    assert session is not None
    assert session.user_name == "Carlos Baterista"
    assert session.token is not None

    # Valid session lookup
    valid = auth.validate_session(session.token)
    assert valid is not None
    assert valid.user_id == session.user_id

    # Code cannot be reused
    reused = auth.verify_otp(phone, code)
    assert reused is None


def test_otp_rate_limiting():
    """Verify brute force prevention after 3 failed OTP attempts."""
    auth = AuthService(otp_ttl_seconds=300)
    phone = "+573009998877"
    _code = auth.generate_otp(phone, channel="sms")

    # 3 bad attempts
    assert auth.verify_otp(phone, "000000") is None
    assert auth.verify_otp(phone, "111111") is None
    assert auth.verify_otp(phone, "222222") is None

    # 4th attempt (even with right code if it was right) should fail because record was invalidated
    assert auth.verify_otp(phone, _code) is None


def test_google_oauth_flow():
    """Verify Google OAuth user creation and session creation."""
    auth = AuthService()
    email = "director@bandait.live"
    name = "Director Musical"
    sub = "10987654321"

    session = auth.authenticate_google(email, name, sub)
    assert session is not None
    assert session.user_name == "Director Musical"

    valid = auth.validate_session(session.token)
    assert valid is not None
    assert valid.user_id == session.user_id


def test_multi_band_organization_and_roles():
    """Verify multi-band registration, memberships, switching, and granular roles."""
    auth = AuthService()

    # Create Owner
    owner_session = auth.authenticate_google("owner@bandait.live", "Andrés Owner", "sub_owner_1")
    owner_id = owner_session.user_id

    # Register 2 bands
    band_rock = auth.register_band("band_rock", "Los Inquietos del Rock", owner_id)
    band_jazz = auth.register_band("band_jazz", "Pereira Jazz Quartet", owner_id)

    assert band_rock.name == "Los Inquietos del Rock"
    assert band_jazz.name == "Pereira Jazz Quartet"

    # Add Musician to band_rock, SoundEngineer to band_jazz
    musician_session = auth.verify_otp("+573001112233", auth.generate_otp("+573001112233"), "Mateo Bajo")
    musician_id = musician_session.user_id

    auth.add_member_to_band("band_rock", musician_id, MemberRole.MUSICIAN, name="Mateo Bajo", instrument="Bajo")
    auth.add_member_to_band("band_jazz", musician_id, MemberRole.SOUND_ENGINEER, name="Mateo Sonido")

    bands = auth.list_user_bands(musician_id)
    assert len(bands) == 2

    # Verify switching active band
    switched_rock = auth.switch_band(musician_session.token, "band_rock")
    assert switched_rock is not None
    assert switched_rock.active_band_id == "band_rock"
    assert switched_rock.role == MemberRole.MUSICIAN

    switched_jazz = auth.switch_band(musician_session.token, "band_jazz")
    assert switched_jazz is not None
    assert switched_jazz.active_band_id == "band_jazz"
    assert switched_jazz.role == MemberRole.SOUND_ENGINEER


def test_granular_permissions():
    """Verify role permission boundaries."""
    # Musician cannot edit setlist
    assert not AuthService.has_permission(MemberRole.MUSICIAN, "edit_setlist")
    assert not AuthService.has_permission(MemberRole.MUSICIAN, "import_export_xlsx")
    assert AuthService.has_permission(MemberRole.MUSICIAN, "control_transport")
    assert AuthService.has_permission(MemberRole.MUSICIAN, "view_lyrics")

    # MusicDirector can edit setlist & export xlsx
    assert AuthService.has_permission(MemberRole.MUSIC_DIRECTOR, "edit_setlist")
    assert AuthService.has_permission(MemberRole.MUSIC_DIRECTOR, "import_export_xlsx")
    assert AuthService.has_permission(MemberRole.MUSIC_DIRECTOR, "adjust_foh_mix")

    # SoundEngineer can adjust FOH mix
    assert AuthService.has_permission(MemberRole.SOUND_ENGINEER, "adjust_foh_mix")
    assert not AuthService.has_permission(MemberRole.SOUND_ENGINEER, "manage_team")


if __name__ == "__main__":
    test_otp_flow_success()
    test_otp_rate_limiting()
    test_google_oauth_flow()
    test_multi_band_organization_and_roles()
    test_granular_permissions()
    print("ALL AUTH SERVICE TESTS PASSED OK")
