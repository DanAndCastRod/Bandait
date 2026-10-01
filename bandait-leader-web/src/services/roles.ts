import type { BandMember, MemberRole } from '../types/hub.ts'

/**
 * Guardia de roles del lado del cliente.
 *
 * IMPORTANTE: esto NO es seguridad. El workspace completo es un JSON de un solo
 * usuario; quien edite su propio localStorage o su propia fila puede escribir lo que
 * quiera. La aplicacion real de permisos exige tablas por banda con RLS en el servidor
 * (pendiente; ver docs/DEPLOY.md). Esta guardia solo evita errores de operacion:
 * - solo un Owner puede cambiar roles;
 * - nadie puede cambiar su propio rol;
 * - siempre debe quedar al menos un Owner.
 */

export interface RoleChangeCheck {
  ok: boolean
  reason?: string
}

export interface RoleActor {
  userId: string
  /** ownerId de la banda: cuenta como Owner aunque no figure en la lista de integrantes. */
  bandOwnerId?: string | null
}

export function resolveActorRole(members: BandMember[], actor: RoleActor): MemberRole | null {
  const own = members.find((m) => m.userId === actor.userId)
  if (own) return own.role
  if (actor.bandOwnerId && actor.bandOwnerId === actor.userId) return 'Owner'
  return null
}

/** Motivo por el que el actor no puede editar el rol de ese integrante (sin mirar el rol destino). */
export function roleEditBlockReason(
  members: BandMember[],
  actor: RoleActor,
  targetMemberId: string
): string | null {
  const target = members.find((m) => m.id === targetMemberId)
  if (!target) return 'Integrante no encontrado.'
  if (resolveActorRole(members, actor) !== 'Owner') return 'Solo un Owner puede cambiar roles.'
  if (target.userId === actor.userId) return 'No puedes cambiar tu propio rol.'
  return null
}

export function checkRoleChange(
  members: BandMember[],
  actor: RoleActor,
  targetMemberId: string,
  newRole: MemberRole
): RoleChangeCheck {
  const blocked = roleEditBlockReason(members, actor, targetMemberId)
  if (blocked) return { ok: false, reason: blocked }
  const target = members.find((m) => m.id === targetMemberId)
  if (!target) return { ok: false, reason: 'Integrante no encontrado.' }
  if (target.role === newRole) return { ok: true }
  if (target.role === 'Owner' && newRole !== 'Owner') {
    const owners = members.filter((m) => m.role === 'Owner').length
    if (owners <= 1) return { ok: false, reason: 'Debe quedar al menos un Owner en la banda.' }
  }
  return { ok: true }
}
