function bookableDates(now = new Date()) {
  const clinicNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.UTC(clinicNow.getUTCFullYear(), clinicNow.getUTCMonth(), clinicNow.getUTCDate() + index + 1))
    const month = String(day.getUTCMonth() + 1).padStart(2, '0'), date = String(day.getUTCDate()).padStart(2, '0')
    return { key: `${day.getUTCFullYear()}-${month}-${date}`, label: `${month}月${date}日（周${'日一二三四五六'[day.getUTCDay()]}）` }
  })
}
module.exports = { bookableDates }
