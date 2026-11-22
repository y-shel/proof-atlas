import Lean

theorem localFact (p q : Prop) (hp : p) (h : p → q) : q := by
  have hq : q := by
    exact h hp
  exact hq

theorem branches (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor
  · exact hp
  · exact hq

theorem termOnly (p q : Prop) : p → q → p ∧ q :=
  fun hp hq => And.intro hp hq

theorem repeated (p : Prop) (hp : p) : p ∧ p := by
  constructor <;> exact hp
