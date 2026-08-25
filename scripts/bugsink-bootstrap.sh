#!/usr/bin/env bash
set -euo pipefail

compose_file="${BUGSINK_COMPOSE_FILE:-docker-compose.yml}"
compose=(sudo docker compose)
if [[ -n "${BUGSINK_COMPOSE_PROJECT:-}" ]]; then
  compose+=(-p "$BUGSINK_COMPOSE_PROJECT")
fi
if [[ -n "${BUGSINK_ENV_FILE:-}" ]]; then
  compose+=(--env-file "$BUGSINK_ENV_FILE")
fi
compose+=(-f "$compose_file" --profile observability)

project_name="${BUGSINK_PROJECT_NAME:-ExcaliDash}"
team_name="${BUGSINK_TEAM_NAME:-ExcaliDash}"

"${compose[@]}" exec -T \
  -e BUGSINK_PROJECT_NAME="$project_name" \
  -e BUGSINK_TEAM_NAME="$team_name" \
  bugsink bugsink-manage shell -c '
import os
from django.db import transaction
from projects.models import Project
from teams.models import Team

with transaction.atomic():
    team, team_created = Team.objects.get_or_create(name=os.environ["BUGSINK_TEAM_NAME"])
    project, project_created = Project.objects.get_or_create(
        team=team,
        name=os.environ["BUGSINK_PROJECT_NAME"],
    )

print(f"team_created={str(team_created).lower()}")
print(f"project_created={str(project_created).lower()}")
print(f"project_id={project.id}")
print(f"dsn={project.dsn}")
'
