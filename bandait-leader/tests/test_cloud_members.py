"""fetch_band_members against the fake PostgREST of conftest (never the real Supabase)."""

import pytest

from src.cloud.http import CloudHTTPError, CloudOffline
from src.cloud.members import fetch_band_members
from src.core.leader_config import CloudConfig

BAND = "8a0d3c1e-1111-4222-8333-944455556666"


def config(fake, key=None):
    return CloudConfig(url=fake.url, key=key or fake.api_key, source="env")


def test_reads_members_with_publishable_key_and_user_bearer(fake_supabase):
    fake_supabase.band_members = {BAND: [
        {"email": "laura@example.com", "role": "Musician", "name": "Laura", "instrument": "Voz"},
        {"email": "pipe@example.com", "role": "MusicDirector", "name": "Pipe", "instrument": "Guitarra"},
        {"email": "DANIEL@example.com ", "role": "Owner", "name": "Daniel Castaneda", "instrument": "Teclados"},
        {"email": "", "role": "Musician"},  # malformed: skipped
        "basura",
        {"email": "x@example.com", "role": "Rey", "name": None, "instrument": 3},
    ]}
    access, _refresh = fake_supabase.issue()
    members = fetch_band_members(config(fake_supabase), access, BAND)
    assert members == [
        {"email": "daniel@example.com", "role": "Owner", "name": "Daniel Castaneda", "instrument": "Teclados"},
        {"email": "pipe@example.com", "role": "MusicDirector", "name": "Pipe", "instrument": "Guitarra"},
        {"email": "laura@example.com", "role": "Musician", "name": "Laura", "instrument": "Voz"},
        {"email": "x@example.com", "role": "Musician", "name": "", "instrument": ""},
    ]
    method, path, headers, _body = fake_supabase.requests[-1]
    assert method == "GET" and path.startswith("/rest/v1/bandait_band_members?")
    assert f"band_id=eq.{BAND}" in path
    lowered = {k.lower(): v for k, v in headers.items()}
    assert lowered["apikey"] == fake_supabase.api_key
    assert lowered["authorization"] == f"Bearer {access}"
    assert fake_supabase.rest_writes == []  # read only


def test_band_the_user_does_not_belong_to_is_empty(fake_supabase):
    fake_supabase.band_members = {BAND: [{"email": "a@example.com", "role": "Owner"}]}
    access, _ = fake_supabase.issue()
    assert fetch_band_members(config(fake_supabase), access, "otra-banda") == []
    assert fetch_band_members(config(fake_supabase), access, "  ") == []


def test_missing_table_means_no_members(fake_supabase):
    access, _ = fake_supabase.issue()
    assert fetch_band_members(config(fake_supabase), access, BAND) == []


def test_expired_session_and_offline_raise(fake_supabase):
    fake_supabase.band_members = {}
    access, _ = fake_supabase.issue()
    fake_supabase.expire_access_tokens()
    with pytest.raises(CloudHTTPError) as err:
        fetch_band_members(config(fake_supabase), access, BAND)
    assert err.value.status == 401
    url = fake_supabase.url
    fake_supabase.stop()
    with pytest.raises(CloudOffline):
        fetch_band_members(CloudConfig(url=url, key="k", source="env"), access, BAND, timeout=2)
