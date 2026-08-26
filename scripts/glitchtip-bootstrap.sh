#!/usr/bin/env bash
set -euo pipefail

compose_file="${GLITCHTIP_COMPOSE_FILE:-docker-compose.yml}"
compose=(sudo docker compose)
if [[ -n "${GLITCHTIP_COMPOSE_PROJECT:-}" ]]; then
  compose+=(-p "$GLITCHTIP_COMPOSE_PROJECT")
fi
if [[ -n "${GLITCHTIP_ENV_FILE:-}" ]]; then
  compose+=(--env-file "$GLITCHTIP_ENV_FILE")
fi
compose+=(-f "$compose_file" --profile observability)

admin_email="${GLITCHTIP_ADMIN_EMAIL:?set GLITCHTIP_ADMIN_EMAIL}"
admin_password="${GLITCHTIP_ADMIN_PASSWORD:?set GLITCHTIP_ADMIN_PASSWORD}"
organization_name="${GLITCHTIP_ORGANIZATION_NAME:-ExcaliDash}"
project_name="${GLITCHTIP_PROJECT_NAME:-ExcaliDash}"

"${compose[@]}" exec -T \
  -e GLITCHTIP_ADMIN_EMAIL="$admin_email" \
  -e GLITCHTIP_ADMIN_PASSWORD="$admin_password" \
  -e GLITCHTIP_ORGANIZATION_NAME="$organization_name" \
  -e GLITCHTIP_PROJECT_NAME="$project_name" \
  glitchtip ./manage.py shell -c '
import os

from allauth.account.models import EmailAddress
from django.db import transaction
from django.utils.text import slugify

from apps.organizations_ext.models import Organization
from apps.projects.models import Project, ProjectKey
from apps.teams.models import Team
from apps.users.models import User

email = os.environ["GLITCHTIP_ADMIN_EMAIL"]
password = os.environ["GLITCHTIP_ADMIN_PASSWORD"]
organization_name = os.environ["GLITCHTIP_ORGANIZATION_NAME"]
project_name = os.environ["GLITCHTIP_PROJECT_NAME"]

with transaction.atomic():
    user, user_created = User.objects.get_or_create(
        email=email,
        defaults={"is_staff": True, "is_superuser": True},
    )
    user.is_staff = True
    user.is_superuser = True
    user.set_password(password)
    user.save()
    EmailAddress.objects.update_or_create(
        user=user,
        email=email,
        defaults={"primary": True, "verified": True},
    )

    organization, organization_created = Organization.objects.get_or_create(
        slug=slugify(organization_name),
        defaults={"name": organization_name},
    )
    if not organization.users.filter(pk=user.pk).exists():
        organization.add_user(user)

    project, project_created = Project.objects.get_or_create(
        organization=organization,
        slug=slugify(project_name),
        defaults={"name": project_name},
    )
    team, team_created = Team.objects.get_or_create(
        organization=organization,
        slug=slugify(organization_name),
    )
    organization_user = organization.organization_users.get(user=user)
    team.members.add(organization_user)
    team.projects.add(project)

    project_key = ProjectKey.objects.filter(project=project).first()
    if project_key is None:
        raise RuntimeError("GlitchTip did not create a project ingest key")

print(f"user_created={str(user_created).lower()}")
print(f"organization_created={str(organization_created).lower()}")
print(f"project_created={str(project_created).lower()}")
print(f"team_created={str(team_created).lower()}")
print(f"project_id={project.id}")
print(f"dsn={project_key.get_dsn()}")
'
