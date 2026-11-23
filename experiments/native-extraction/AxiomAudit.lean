import Lean

namespace AuditFixture

theorem constructive (p : Prop) (hp : p) : p := by
  exact hp

theorem admitted : False := by sorry

theorem viaAdmission : False := by
  exact admitted

axiom injectedFalse : False
axiom anotherFalse : False

theorem viaAxioms : False ∧ False := by
  exact ⟨injectedFalse, anotherFalse⟩

axiom «Ｚ» : True
axiom «𝕫» : True

theorem unicodeBasis : True ∧ True := by
  exact ⟨«𝕫», «Ｚ»⟩

axiom assumedType : Type

def typeDependency (x : assumedType) : assumedType := x

def tally : List Bool → Nat
  | [] => 0
  | b :: rest => if b then Nat.succ (tally rest) else tally rest

theorem tallyAppend (xs ys : List Bool) (offset : Nat) :
    tally (xs ++ ys) = tally xs + tally ys ∧
    tally (xs ++ ys) + offset = tally xs + (tally ys + offset) := by
  induction xs with
  | nil =>
    constructor
    · simp [tally]
    · simp [tally]
  | cons b rest ih =>
    have shared : tally (rest ++ ys) = tally rest + tally ys := ih.1
    have shifted : tally (rest ++ ys) + offset =
        tally rest + (tally ys + offset) := by
      rw [shared, Nat.add_assoc]
    cases b with
    | false =>
      constructor
      · simpa [tally] using shared
      · simpa [tally] using shifted
    | true =>
      constructor
      · simpa [tally, Nat.succ_add] using congrArg Nat.succ shared
      · simpa [tally, Nat.succ_add] using congrArg Nat.succ shifted

end AuditFixture
