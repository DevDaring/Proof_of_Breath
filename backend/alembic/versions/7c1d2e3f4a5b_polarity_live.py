"""settings.polarity_live: whether the breath sign came from a real sensor

Revision ID: 7c1d2e3f4a5b
Revises: 0b3e2c4ccf86
"""
from alembic import op
import sqlalchemy as sa

revision = '7c1d2e3f4a5b'
down_revision = '0b3e2c4ccf86'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('settings', sa.Column('polarity_live', sa.Boolean(), server_default=sa.false(), nullable=False))
    # Before this column existed only the owner could calibrate, and only with the desktop bridge.
    op.execute("UPDATE settings SET polarity_live = true FROM workspaces "
               "WHERE workspaces.id = settings.workspace_id AND workspaces.kind = 'owner' AND settings.breath_polarity IS NOT NULL")


def downgrade() -> None:
    op.drop_column('settings', 'polarity_live')
